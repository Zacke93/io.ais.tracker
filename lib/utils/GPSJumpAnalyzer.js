'use strict';

const geometry = require('./geometry');
const constants = require('../constants');

/**
 * H2 (helkodsgranskning runda 1, 2026-08-22) — TAK FÖR SVÄNGUNDANTAGET.
 *
 * F64 lade fysikgrinden på >300 m men villkorade den på "ingen tydlig sväng"
 * (cogChange okänd eller ≤ 45°). Undantaget hade INGEN övre gräns: vid större
 * kursändring hoppade koden direkt till vessel_turning-grenen, vars enda krav
 * är legitimacyScore ≥ 0,4 — och poängens GOLV är exakt 0,40, så kravet
 * filtrerar ingenting. Logiken blev därtill inverterad mot distans: ~500 m
 * omöjligt gav accept_with_caution, medan samma omöjlighet MED sväng gav
 * naket accept utan flagga. Utfallet när den slår är critical-klass: ett
 * 4773 m-segment gav passed för fyra broar, tre fabricerade passager och en
 * felaktig målbrotransition.
 *
 * MULTIPELN, INTE ETT FARTSTAK: maxRealisticDistanceM bär redan 2,0× marginal
 * för ögonblicksfart, acceleration och kanalström. Ett ytterligare tak på
 * 3× betyder alltså att rörelsen måste överstiga SEX gånger den rapporterade
 * farten innan svängundantaget upphör — en manöver kan förlänga vägen (en
 * gir är längre än kordan) men aldrig sexdubbla den. Ett absolut fartstak
 * (~20 kn) valdes bort: det bryter det låsta U-svängsfallet i
 * tests/gps-physics-gate.test.js (666 m på 30 s ⇒ 43,2 kn implicerat), medan
 * multipeln ger taket 740,8 m i exakt det fallet och släpper det orört.
 *
 * MÄTT FACITNEUTRAL: två oberoende svep över samtliga låsta korpusar och
 * fältloggar (14 530 respektive 17 219 positionspar, ~330 h) fann NOLL par
 * som tog undantagsvägen — grinden är ett skyddsnät, inte en verkanshöjare.
 */
const TURN_EXEMPTION_MAX_MULTIPLE = 3;

/**
 * GPSJumpAnalyzer - Sophisticated GPS jump detection with direction change analysis
 * Distinguishes between real GPS errors and legitimate large movements (U-turns, direction changes)
 */
class GPSJumpAnalyzer {
  // Samma bevisfönster som passagekandidaternas livstid. Varken en kandidat
  // eller en återhämtningsposition får leva vidare som gammalt passagebevis.
  static PASSAGE_RECOVERY_MAX_AGE_MS = 20 * 60 * 1000;

  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Fysikgrindarna behöver fixets rapporterade fart. Det klistrande sog-
   * värdet på fartygsobjektet kan tillhöra en äldre fix och får inte göra
   * ett nytt "fart okänd" till bevisad stillhet. Äldre rena fixobjekt utan
   * råfält använder sitt vanliga sog-fält.
   */
  static positionSog(vessel) {
    const sog = vessel && Object.prototype.hasOwnProperty.call(vessel, '_rawPositionSog')
      ? vessel._rawPositionSog : vessel?.sog;
    return Number.isFinite(sog) ? sog : null;
  }

  /**
   * En fysiskt orimlig position behöver ett nytt bekräftande fix innan den
   * får bevisa passage. Det gäller även rörliga båtar. Allmän osäkerhet
   * efter ett långt AIS-glapp är däremot inte samma sak som ett GPS-hopp.
   * Regeln används för BÅDA ändpunkterna i ett passagesegment.
   */
  static needsPassageConfirmation(vessel) {
    return vessel?._gpsJumpDetected === true
      || (vessel?._positionUncertain === true
        && vessel?._positionAnalysis?.reason === 'medium_movement_speed_mismatch');
  }

  static passageRecoveryPosition(oldVessel) {
    const position = oldVessel?._gpsJumpDetected || oldVessel?._positionUncertain
      ? oldVessel?._passageRecoveryPosition : oldVessel;
    if (!Number.isFinite(position?.lat) || !Number.isFinite(position?.lon)
        || !Number.isFinite(position?.timestamp)) return null;
    const age = Date.now() - position.timestamp;
    if (age < 0 || age > GPSJumpAnalyzer.PASSAGE_RECOVERY_MAX_AGE_MS) return null;
    // Endast positionsvärden: ingen referenskedja till gamla fartygsobjekt.
    const {
      lat, lon, timestamp, fixTs, fixFeed, lastPositionUpdate, sog, cog,
    } = position;
    return {
      lat,
      lon,
      timestamp,
      fixTs,
      fixFeed,
      lastPositionUpdate,
      sog,
      cog,
      // Återhämtningssegmentet ska bära den rena fixens råfart. Annars
      // ärver passageSegmentStart råfarten från det senare GPS-hoppet
      // när koordinaterna läggs tillbaka på det osäkra fartygsobjektet.
      _rawPositionSog: GPSJumpAnalyzer.positionSog(position),
      // Samma sak för råkursen (K1-granskningen 2026-11-16, L2): annars ärver
      // återhämtningsstarten råkursen från den senare, osäkra fixen medan
      // läget, tiden och farten kommer från den rena. Stillagrindens undantag
      // (GPSJumpGateService._stopExplainedByPriorTransit) läser den. Saknar
      // den rena fixen kurs blir fältet null, och då prövas ingen kurs.
      _rawPositionCog: GPSJumpAnalyzer.positionCog(position),
    };
  }

  /**
   * Fixens rapporterade kurs, med samma regel som positionSog: råfältet när
   * det finns (även null, "kurs ej tillgänglig"), annars det vanliga
   * cog-fältet. Icke-finit kurs ⇒ null.
   */
  static positionCog(vessel) {
    const cog = vessel && Object.prototype.hasOwnProperty.call(vessel, '_rawPositionCog')
      ? vessel._rawPositionCog : vessel?.cog;
    return Number.isFinite(cog) ? cog : null;
  }

  // K1/N4: marginalen och bäringsgränsen i regeln för ett stopp efter färd
  // (stopExplainedByPriorTransit). Samma värden som analysatorns egna
  // literaler: 2,0 i maxRealisticDistance och medelgrenens tak, 45° i
  // _checkBearingConsistency. Ändras de där ska de ändras här också.
  static PRIOR_TRANSIT_SPEED_MARGIN = 2.0;

  static PRIOR_TRANSIT_BEARING_MAX_DEG = 45;

  /**
   * EN REGEL för "stoppet förklaras av färden före glappet" (K1 2026-11-16,
   * U40/N4 2026-11-16). Används av analysatorn (ett stopp är inget GPS-hopp,
   * se _analyzeLargeMovement) och av stillagrinden
   * (GPSJumpGateService._stopExplainedByPriorTransit, som dessutom kräver att
   * stillafixen ligger utanför jitterbandet kring den prövade bron).
   *
   * Alla tre villkor ska hålla; inga nya trösklar:
   *  1. Startfixen är ren (varken _gpsJumpDetected eller _positionUncertain)
   *     och har finit rå sog ≥ MOVEMENT_PROOF_SOG_KN (bevisad rörelse).
   *  2. Förflyttningen ≤ startfart × fix-dt × 2,0 (fixDtMs, annars
   *     mottagningstid, som analysatorn). Ett hopp längre än färden står kvar.
   *  3. Bäringen start → ny position inom 45° från startfixens råkurs. Okänd
   *     startkurs prövas inte (S-F1), men villkor 1 och 2 gäller ändå.
   * Regeln säger inget om den nya fixens fart; anroparen kräver stillhet.
   * @param {Object} current - {lat, lon, fixTs, fixFeed, timestamp}
   * @param {Object} start - segmentets rena startfix
   * @returns {boolean}
   */
  static stopExplainedByPriorTransit(current, start) {
    if (!current || !start) return false;
    if (start._gpsJumpDetected === true || start._positionUncertain === true) return false;

    const startSog = GPSJumpAnalyzer.positionSog(start);
    if (startSog === null || startSog < constants.MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN) return false;

    let dtMs = GPSJumpAnalyzer.fixDtMs(current, start);
    if (dtMs === null) dtMs = current.timestamp - start.timestamp;
    if (!Number.isFinite(dtMs) || dtMs <= 0) return false;

    const distanceM = geometry.calculateDistance(start.lat, start.lon, current.lat, current.lon);
    if (!Number.isFinite(distanceM)) return false;
    const explainedM = startSog * 1852 * (dtMs / 3600000) * GPSJumpAnalyzer.PRIOR_TRANSIT_SPEED_MARGIN;
    if (distanceM > explainedM) return false;

    const startCog = GPSJumpAnalyzer.positionCog(start);
    if (startCog !== null && startCog >= 0 && startCog < 360 && distanceM > 0) {
      let bearing;
      try {
        bearing = geometry.calculateBearing(start.lat, start.lon, current.lat, current.lon);
      } catch (_) {
        return false;
      }
      if (geometry.normalizeAngleDiff(bearing, startCog) > GPSJumpAnalyzer.PRIOR_TRANSIT_BEARING_MAX_DEG) return false;
    }
    return true;
  }

  static passageSegmentStart(oldVessel) {
    if (!GPSJumpAnalyzer.needsPassageConfirmation(oldVessel)) return oldVessel;
    const position = GPSJumpAnalyzer.passageRecoveryPosition(oldVessel);
    if (!position) return null;
    // Resans tillstånd är aktuellt, men korsningen mäts från senaste rena
    // positionen. Då går en äkta passage under återhämtningen att upptäcka.
    return {
      ...oldVessel, ...position, _gpsJumpDetected: false, _positionUncertain: false,
    };
  }

  /**
   * KANONISK klockdomänregel för fysik-dt (ägs här, återanvänds av
   * GPSJumpGateService och VesselDataService — regeln får finnas på EN plats).
   *
   * Etapp 0 AISHub-förberedelse (2026-08-02), SAMMA KÄLLA: fixtids-dt när
   * båda samplen bär fixtid från samma källa. Klockdomänsinvarianten:
   * mottagningstid och äkta fixtid får ALDRIG blandas i en tidsjämförelse —
   * en pollande källa levererar fix som är upp till minuter äldre än
   * mottagningen, och ett blandat dt dömer legitim rörelse som fysiskt
   * omöjlig (eller tvärtom). Negativ separation (klockbakhopp) lämnas
   * OFÖRÄNDRAT till anroparens egen klamp.
   *
   * V8 (A/B-nattkörningen 2026-08-03), KORSKÄLLA: 49 % av uppdateringarna i
   * 'both'-läget bytte källa mellan två konsekutiva fixar, och de föll förut
   * tillbaka på MOTTAGNINGSTID — exakt den blandning doktrinen förbjuder.
   * Felet var systematiskt: JUNO 265576720 kl. 05:54:47 flyttade 245 m mellan
   * en AISHub-fix och en aisstream-fix som mottogs 17 s isär men vars FIXAR
   * låg 51 s isär ⇒ implicerad fart 28,6 kn mot verkliga 9,4 ⇒ falsk
   * positionUncertain ⇒ _canAssignTarget avvisade måltilldelningen. BÅDA
   * källornas fixTs approximerar EMISSIONSTID (aisstream: mottagning vid
   * push, millisekunder efter emissionen; AISHub: äkta TIME), så separationen
   * mellan dem ÄR en giltig fysik-dt — mottagningstiden bär däremot hubbens
   * pollfördröjning och är det enda som får blandas in.
   *
   * KORSKÄLLA FÅR BARA VIDGA FÖNSTRET (granskningsrunda 2, 2026-08-03).
   * V8 motiverades ENSIDIGT — alla åberopade vinster (JUNO 51 s mot 17 s, TIM
   * 33 s mot 19 s) är riktningen aishub→aisstream, där fixseparationen är
   * LÄNGRE än mottagningsseparationen därför att hubbens pollfördröjning
   * pressade ihop leveranserna. Den motsatta riktningen (aisstream→aishub)
   * KRYMPER i stället fönstret systematiskt — mätt över nattkorpusen: 252 av
   * 507 accepterade korskällepar, kvot fixDt/recvDt p10/median/p90 =
   * 0,56/0,84/0,95 — och ett kortare fönster INFLATERAR varje härledd fart.
   * Konkret följd: TIDAN 231907000 22:59:01→22:59:15 fick northMps 0,333 mot
   * 0,161, vilket släpper FP9-H':s kajvobbelgrind (tröskel 0,25) — precis den
   * grind som finns för att PRICKBJORN/HEY JOE-klassen inte ska få målbro på
   * kajbrus. Regeln är därför: korskälle-fixDt används ENDAST när den är minst
   * lika lång som mottagningsseparationen. Då behålls varje citerad vinst
   * oförändrad, medan ingen fysikgrind kan bli MER tillåtande än före V8.
   *
   * ÖVRE SANITETSGRÄNS: vidgningen (fixDt − recvDt) ÄR hubbens egen
   * leveranslagg för det äldre samplet; nattens 1014 hub-fixar hade median
   * 27,5 s, p90 62,3 s och max 220,9 s. Bortom CROSS_FEED_MAX_FIX_DT_EXCESS_MS
   * är separationen inte längre en pollfördröjning utan en klock- eller
   * dataanomali, och ett uppblåst fönster gör grindarna godtyckligt
   * tillåtande (allowedPositionChangeM växer linjärt med dt).
   *
   * DEFENSIVT: koden antar ALDRIG att korskälleseparationen är framåt (F6 i
   * fusionslagret gör den det i praktiken, men P3 får inte bero på P1). En
   * släpande hub-fix som landar efter en färsk aisstream-fix ger dt ≤ 0, och
   * hubbens sekundupplösta TIME gör allt under CROSS_FEED_MIN_FIX_DT_MS till
   * kvantiseringsbrus. I samtliga fall: null ⇒ anroparen behåller dagens
   * mottagningstidsuttryck, alltså ingen ny felmod.
   *
   * @param {object} currentVessel - nyare sampel (fixTs/fixFeed/timestamp)
   * @param {object} oldVessel - äldre sampel (fixTs/fixFeed/timestamp)
   * @returns {number|null} fixseparation i ms, eller null när den saknas
   */
  static fixDtMs(currentVessel, oldVessel) {
    if (!currentVessel || !oldVessel) return null;
    if (!currentVessel.fixFeed || !oldVessel.fixFeed) return null;
    if (!Number.isFinite(currentVessel.fixTs) || !Number.isFinite(oldVessel.fixTs)) return null;
    const dtMs = currentVessel.fixTs - oldVessel.fixTs;
    if (currentVessel.fixFeed === oldVessel.fixFeed) return dtMs;

    const cfg = constants.AIS_CONFIG.FUSION;
    if (dtMs < cfg.CROSS_FEED_MIN_FIX_DT_MS) return null;
    // MOTTAGNINGSSEPARATIONEN är referensen. Saknas den (snapshot utan
    // timestamp) finns inget att jämföra mot ⇒ ingen korskälle-dt.
    const curRecv = Number.isFinite(currentVessel.timestamp) ? currentVessel.timestamp : null;
    const oldRecv = Number.isFinite(oldVessel.timestamp) ? oldVessel.timestamp : null;
    if (curRecv === null || oldRecv === null) return null;
    const recvDtMs = curRecv - oldRecv;
    if (!Number.isFinite(recvDtMs) || dtMs < recvDtMs) return null; // får bara VIDGA
    if (dtMs - recvDtMs > cfg.CROSS_FEED_MAX_FIX_DT_EXCESS_MS) return null; // sanitetstak
    return dtMs;
  }

  /**
   * Analyze movement to determine if it's a GPS jump or legitimate movement
   * @param {string} mmsi - Vessel MMSI
   * @param {Object} currentPosition - Current position {lat, lon}
   * @param {Object} previousPosition - Previous position {lat, lon}
   * @param {Object} currentVessel - Current vessel data (including COG, SOG)
   * @param {Object} oldVessel - Previous vessel data
   * @returns {Object} Analysis result with recommended action
   */
  analyzeMovement(mmsi, currentPosition, previousPosition, currentVessel, oldVessel) {
    if (!previousPosition || !oldVessel) {
      return {
        action: 'accept',
        reason: 'no_previous_data',
        isGPSJump: false,
        isLegitimateMovement: true,
        movementDistance: 0,
      };
    }

    // Calculate movement distance
    const movementDistance = geometry.calculateDistance(
      previousPosition.lat, previousPosition.lon,
      currentPosition.lat, currentPosition.lon,
    );

    const result = {
      movementDistance,
      action: 'accept',
      reason: 'normal_movement',
      isGPSJump: false,
      isLegitimateMovement: true,
      confidence: 'high',
      analysis: {},
    };

    // Small movements - always accept
    if (movementDistance <= 100) {
      return result;
    }

    // Large movements - analyze further
    if (movementDistance > 500) {
      return this._analyzeLargeMovement(mmsi, currentPosition, previousPosition, currentVessel, oldVessel, result);
    }

    // Medium movements (100-500m) - accept with caution
    // S-F4 (2026-07-01): mellanintervallet accepterades tidigare BLINT — en
    // enda multipath-outlier på 100–500 m hos en (nära) stillaliggande båt
    // gav falsk linjekorsningspassage över bron och förgiftade det klistrande
    // rörelsebeviset. Fysikgata: överskrider förflyttningen vad rapporterad
    // sog rimligen medger (2× marginal, 1 kn-golv för still/långsam) →
    // accept_with_caution (⇒ positionUncertain i pipelinen). Normala Class
    // B-gap klarar gatan med god marginal (3 min @ 5 kn ⇒ tak ~926 m).
    // Helgranskning 2026-07-06 (gpsjump#2): samma klockbakhoppsklamp som
    // stora-rörelse-grenen (rad ~98) — negativt delta (NTP-korrigering) gav
    // annars ett mikroskopiskt tillåtet avstånd → falsk accept_with_caution.
    // Etapp 0 + V8: fixtids-dt när fixseparationen är användbar (samma källa,
    // eller korskälla med framåt separation) — annars mottagningstid som förut.
    const medFixDtMs = GPSJumpAnalyzer.fixDtMs(currentVessel, oldVessel);
    let medTimeElapsedMs = medFixDtMs !== null
      ? medFixDtMs
      : Date.now() - (oldVessel.timestamp || Date.now());
    if (medTimeElapsedMs < 0) {
      medTimeElapsedMs = 60 * 1000;
    }
    const medTimeElapsedHours = Math.max(medTimeElapsedMs / 3600000, 0.001);
    // Helgranskning 2026-07-06 (scenario 'fartgivarlös-genomresa' avslöjade
    // detta): med sog=null på BÅDA samples (Class B utan fartgivare) gav
    // `sog || 0` maxfart = 1 kn-golvet → tillåtet ~62 m/min medan båten
    // legitimt går 140 m/min → VARJE sample dömdes "osäker" → måltilldelning
    // avvisad → båten permanent osynlig (P1+P2). Okänd fart kan inte
    // fysikgatas strikt: anta kanal-realistisk maxfart (5 kn, samma golv som
    // storgrenens) — 100–300 m-outliers på stilla båtar släpps då för denna
    // klass, men 1 kn-golvet gäller oförändrat när farten ÄR känd.
    const medCurrentSog = GPSJumpAnalyzer.positionSog(currentVessel);
    const medOldSog = GPSJumpAnalyzer.positionSog(oldVessel);
    // Helgranskning 2026-07-10 (GJ-2): 5 kn-golvet gäller när NÅGOT av
    // samplen saknar sog, inte bara när båda gör det — en avgående väntare
    // (gammal sog 0,3, nytt sample null) föll annars på 1 kn-golvet och en
    // legitim avfärd på 100–500 m dömdes positionUncertain. Okänd fart på
    // ena sidan gör intervallets verkliga fart okänd; gata inte strikt då.
    const medMaxSpeedKn = (medCurrentSog === null || medOldSog === null)
      ? Math.max(medCurrentSog ?? 0, medOldSog ?? 0, 5)
      : Math.max(medCurrentSog, medOldSog, 1);
    const medRealisticM = medMaxSpeedKn * medTimeElapsedHours * 2.0 * 1852;
    if (movementDistance > medRealisticM) {
      result.action = 'accept_with_caution';
      result.reason = 'medium_movement_speed_mismatch';
      result.confidence = 'low';
      this.logger.debug(
        `⚠️ [GPS_MEDIUM_SUSPECT] ${mmsi}: ${movementDistance.toFixed(0)}m on `
        + `${(medTimeElapsedMs / 1000).toFixed(0)}s exceeds realistic `
        + `${medRealisticM.toFixed(0)}m (sog ${medMaxSpeedKn.toFixed(1)}kn) — position uncertain`,
      );
      return result;
    }
    result.reason = 'medium_movement';
    result.confidence = 'medium';
    return result;
  }

  /**
   * Analyze large movements (>500m) to determine if GPS jump or legitimate movement
   * @private
   */
  _analyzeLargeMovement(mmsi, currentPosition, previousPosition, currentVessel, oldVessel, result) {
    // Etapp 0 + V8: fixtids-dt när fixseparationen är användbar (samma källa,
    // eller korskälla med framåt separation) — annars mottagningstid som förut.
    const fixDtMs = GPSJumpAnalyzer.fixDtMs(currentVessel, oldVessel);
    let timeElapsedMs = fixDtMs !== null
      ? fixDtMs
      : Date.now() - (oldVessel.timestamp || Date.now());
    // Produktionsredo (2026-07-03): ett klockBAKhopp (NTP-korrigering) gav
    // negativt delta som golvades till ~0 h — maxRealisticDistance kollapsade
    // och normal förflyttning dömdes som GPS-hopp en tick. Vid bakhopp är
    // tiden okänd: anta ett typiskt rapportintervall i stället.
    if (timeElapsedMs < 0) {
      timeElapsedMs = 60 * 1000;
    }
    const timeElapsedHours = Math.max(timeElapsedMs / (1000 * 60 * 60), 0.001); // Avoid division by zero

    result.analysis = {
      movementDistance: result.movementDistance,
      timeElapsed: timeElapsedMs,
      cogChange: this._calculateCOGChange(currentVessel.cog, oldVessel.cog),
      sogChange: Math.abs((GPSJumpAnalyzer.positionSog(currentVessel) ?? 0)
        - (GPSJumpAnalyzer.positionSog(oldVessel) ?? 0)),
      bearingConsistency: this._checkBearingConsistency(currentPosition, previousPosition, currentVessel.cog),
      speedConsistency: this._checkSpeedConsistency(result.movementDistance, currentVessel, oldVessel),
    };

    // IMPROVED: Calculate maximum realistic distance based on vessel speed
    // 2.0x margin accounts for: AIS speed being a snapshot (not average),
    // deceleration/acceleration during gap, and canal current assistance
    const maxSpeed = Math.max(
      GPSJumpAnalyzer.positionSog(currentVessel) ?? 0,
      GPSJumpAnalyzer.positionSog(oldVessel) ?? 0,
      5,
    ); // Min 5 knots
    const maxRealisticDistanceNM = maxSpeed * timeElapsedHours * 2.0; // 100% margin
    const maxRealisticDistanceM = maxRealisticDistanceNM * 1852;

    // Evidence of legitimate movement
    const legitimacyScore = this._calculateLegitimacyScore(result.analysis);

    // IMPROVED LOGIC: Better detection of turns vs GPS jumps
    // F64: the deterministic physics gate previously required >800m, so a
    // physically-impossible 500-800m jump with no supporting course change fell
    // through to the legitimacy score (+0.5 baseline) and could be ACCEPTED —
    // injecting a wrong position/ETA/bridge for one tick. Apply the physics gate
    // from >300m, but ONLY when there is no clear turn (cogChange null or ≤45°),
    // so legitimate U-turns/maneuvers (cogChange>45) still fall through to the
    // turn/legitimacy branches below and are not mislabelled as GPS jumps.
    const noClearTurn = result.analysis.cogChange === null || result.analysis.cogChange <= 45;
    // H2 (2026-08-22): svängundantaget har ett TAK. En tydlig kursändring
    // förklarar att vägen blev längre än kordan — den förklarar aldrig att
    // båten färdades mer än TURN_EXEMPTION_MAX_MULTIPLE gånger sin egen
    // (redan 2,0×-marginalerade) maxsträcka. Utan taket var grenen ett dött
    // skyddsnät: vessel_turning nedan kräver bara legitimacyScore ≥ 0,4, och
    // 0,40 ÄR poängens golv. Se TURN_EXEMPTION_MAX_MULTIPLE för härledningen.
    const beyondTurnExemption = result.movementDistance
      > maxRealisticDistanceM * TURN_EXEMPTION_MAX_MULTIPLE;
    if (result.movementDistance > maxRealisticDistanceM
        && result.movementDistance > 300
        && (noClearTurn || beyondTurnExemption)) {
      // Physically impossible - definite GPS jump
      result.action = 'gps_jump_detected';
      result.reason = 'physically_impossible_movement';
      result.isLegitimateMovement = false;
      result.isGPSJump = true;
      result.confidence = 'high';
      this.logger.debug(
        `🚨 [GPS_PHYSICS] ${mmsi}: ${result.movementDistance.toFixed(0)}m exceeds max `
        + `${maxRealisticDistanceM.toFixed(0)}m (${maxSpeed}kn for ${(timeElapsedMs / 1000).toFixed(1)}s)`,
      );
    } else if (result.analysis.cogChange > 45 && legitimacyScore >= 0.4) {
      // Large COG change = turning/maneuvering
      result.action = 'accept';
      result.reason = 'vessel_turning';
      result.isLegitimateMovement = true;
      result.isGPSJump = false;
      result.confidence = result.analysis.cogChange > 90 ? 'high' : 'medium';
    } else if (legitimacyScore >= 0.7) {
      result.action = 'accept';
      result.reason = 'legitimate_direction_change';
      result.isLegitimateMovement = true;
      result.isGPSJump = false;
      result.confidence = 'high';
    } else if (legitimacyScore >= 0.4) {
      result.action = 'accept_with_caution';
      result.reason = 'uncertain_movement';
      result.isLegitimateMovement = true;
      result.isGPSJump = false;
      result.confidence = 'medium';
    } else if (GPSJumpAnalyzer._isStopAfterTransit(currentPosition, currentVessel, oldVessel)) {
      // U40 (N4, 2026-11-16; nattjaktens F16/F17-systerställe): en båt som
      // går genom en bro i transitfart och stannar tvärt strax bortom den.
      // Stillafixens egen kurs och fart 0 får både bäringen och snittfarten
      // att se "fel" ut, och poängen hamnar under 0,4. Det är inget GPS-hopp
      // när stoppet förklaras av färden före glappet (EN regel med K1:
      // stopExplainedByPriorTransit), och stillafixen ligger utanför
      // jitterbandet bortom varje brolinje som segmentet korsat. Fixen blir
      // osäker i stället, så att
      // stillagrinden (S1) och dess K1-undantag avgör passagen per bro. Ett
      // fysiskt omöjligt hopp kan aldrig nå hit: villkor 2 ligger inom taket
      // ovan (max(sog, 5) × dt × 2,0).
      // KÄND GRÄNS: ett brusprov mer än 60 m bortom en brolinje hos en båt som
      // stannat strax FÖRE bron ser i ögonblicket ut exakt som ett stopp strax
      // bortom, och bokförs då som passage (samma gräns som K1). Brus av den
      // storleken hos en stillaliggare finns inte i banken eller fältet.
      result.action = 'accept_with_caution';
      result.reason = 'stop_after_transit';
      result.isLegitimateMovement = true;
      result.isGPSJump = false;
      result.confidence = 'low';
      this.logger.debug(
        `🛑 [GPS_STOP_AFTER_TRANSIT] ${mmsi}: ${result.movementDistance.toFixed(0)}m explained by transit `
        + `before the gap (score ${legitimacyScore.toFixed(2)}) — uncertain, not a GPS jump`,
      );
    } else {
      result.action = 'gps_jump_detected';
      result.reason = 'likely_gps_error';
      result.isLegitimateMovement = false;
      result.isGPSJump = true;
      result.confidence = 'high';
    }

    this._logAnalysis(mmsi, result);
    return result;
  }

  /**
   * U40 (N4): är den nya fixen ett stopp som färden före glappet förklarar?
   * Kräver finit rå sog under MOVEMENT_PROOF_SOG_KN på den nya fixen (samma
   * stillhet som stillagrinden S1 kräver) och regeln stopExplainedByPriorTransit
   * mot föregående fix.
   * @private
   */
  static _isStopAfterTransit(currentPosition, currentVessel, oldVessel) {
    const sog = GPSJumpAnalyzer.positionSog(currentVessel);
    if (sog === null || sog >= constants.MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN) return false;
    // Jitterbandet (samma mått som stillagrindens villkor 4): har segmentet
    // korsat en brolinje och ligger stillafixen inom
    // UNDER_BRIDGE_CROSS_PROOF_JITTER_M bortom den, döms fixen som förut. Där
    // kan ett brusprov hos en båt som stannat strax FÖRE bron se ut precis som
    // ett stopp strax bortom, och hoppdomen är det som gör att nästa fix mäts
    // från den rena startpositionen (passageSegmentStart) så att ingen falsk
    // passage bokförs alls. En bro som segmentet inte korsat spelar ingen roll:
    // där ligger stillafixen kvar på startens sida.
    if (GPSJumpAnalyzer._crossedBridgeWithinJitterBand(oldVessel, currentPosition)) return false;
    return GPSJumpAnalyzer.stopExplainedByPriorTransit({
      lat: currentPosition?.lat,
      lon: currentPosition?.lon,
      fixTs: currentVessel?.fixTs,
      fixFeed: currentVessel?.fixFeed,
      timestamp: currentVessel?.timestamp,
    }, oldVessel);
  }

  /**
   * U40 (N4): korsar segmentet start → pos en brolinje (positionerna på var
   * sin sida, geometry.bridgeLineOffsetM) och ligger pos inom
   * UNDER_BRIDGE_CROSS_PROOF_JITTER_M från den linjen? Bara broar inom sin
   * detektionsradie från pos räknas, så att en avlägsen bros förlängda linje
   * aldrig träffar. Ogiltig position räknas som inom bandet.
   * @private
   */
  static _crossedBridgeWithinJitterBand(start, pos) {
    if (!Number.isFinite(pos?.lat) || !Number.isFinite(pos?.lon)
        || !Number.isFinite(start?.lat) || !Number.isFinite(start?.lon)) return true;
    return Object.values(constants.BRIDGES).some((bridge) => {
      const distanceM = geometry.calculateDistance(pos.lat, pos.lon, bridge.lat, bridge.lon);
      if (!Number.isFinite(distanceM) || distanceM > bridge.radius) return false;
      const offset = geometry.bridgeLineOffsetM(pos, bridge);
      const startOffset = geometry.bridgeLineOffsetM(start, bridge);
      if (!Number.isFinite(offset) || !Number.isFinite(startOffset)) return true;
      const crossed = Math.sign(offset) !== Math.sign(startOffset);
      return crossed && Math.abs(offset) <= constants.UNDER_BRIDGE_CROSS_PROOF_JITTER_M;
    });
  }

  /**
   * Calculate COG change with proper angle wrapping
   * @private
   */
  _calculateCOGChange(currentCOG, previousCOG) {
    if (!Number.isFinite(currentCOG) || !Number.isFinite(previousCOG)) {
      return null;
    }

    let cogChange = Math.abs(currentCOG - previousCOG);
    if (cogChange > 180) {
      cogChange = 360 - cogChange;
    }
    return cogChange;
  }

  /**
   * Check if movement bearing is consistent with reported COG
   * @private
   */
  _checkBearingConsistency(currentPos, prevPos, cog) {
    if (!Number.isFinite(cog)) {
      return null;
    }

    // B5-fix (2026-06-09): calculateBearing KASTAR vid ogiltiga koordinater
    // (till skillnad från calculateDistance som returnerar null) — utan
    // try/catch skulle ett korrupt AIS-meddelande krascha hela jump-analysen.
    let actualBearing;
    try {
      actualBearing = geometry.calculateBearing(
        prevPos.lat, prevPos.lon,
        currentPos.lat, currentPos.lon,
      );
    } catch (error) {
      return null; // ogiltiga koordinater → ingen bearing-bedömning möjlig
    }
    if (!Number.isFinite(actualBearing)) {
      return null;
    }

    const bearingDiff = geometry.normalizeAngleDiff(actualBearing, cog);
    return {
      actualBearing,
      reportedCOG: cog,
      difference: bearingDiff,
      isConsistent: bearingDiff <= 45, // Within 45 degrees is considered consistent
    };
  }

  /**
   * Check if movement distance is consistent with reported speed
   * @private
   */
  _checkSpeedConsistency(movementDistance, currentVessel, oldVessel) {
    // Etapp 0: signaturen tar hela currentVessel (inte bara sog) så fixtids-
    // dt kan beräknas — implied speed över fel tidsbas dömde annars en
    // pollande källas legitima rörelse som inkonsistent. V8: gäller nu även
    // korskällepar (JUNO: 28,6 kn implicerat mot 9,4 verkliga).
    const fixDtMs = GPSJumpAnalyzer.fixDtMs(currentVessel, oldVessel);
    const timeElapsedMs = fixDtMs !== null
      ? fixDtMs
      : Date.now() - (oldVessel.timestamp || Date.now());
    const timeElapsedHours = timeElapsedMs / (1000 * 60 * 60);
    const currentSOG = GPSJumpAnalyzer.positionSog(currentVessel);

    if (timeElapsedHours <= 0) {
      return null;
    }

    // Convert distance to nautical miles and calculate implied speed
    const movementNM = movementDistance / 1852;
    const impliedSpeed = movementNM / timeElapsedHours;

    const reportedSpeed = currentSOG || 0;
    const speedDiff = Math.abs(impliedSpeed - reportedSpeed);

    return {
      impliedSpeed,
      reportedSpeed,
      speedDiff,
      timeElapsed: timeElapsedHours,
      isConsistent: speedDiff <= Math.max(5, reportedSpeed * 0.5), // Within 50% or 5kn
    };
  }

  /**
   * Calculate legitimacy score (0-1) based on all factors
   * @private
   */
  _calculateLegitimacyScore(analysis) {
    let score = 0;
    let factors = 0;

    // COG change factor - large changes indicate direction changes (legitimate)
    if (analysis.cogChange !== null) {
      if (analysis.cogChange > 90) {
        score += 0.4; // Strong evidence of direction change
      } else if (analysis.cogChange > 45) {
        score += 0.2; // Moderate evidence
      }
      factors++;
    }

    // Bearing consistency factor
    if (analysis.bearingConsistency !== null) {
      if (analysis.bearingConsistency.isConsistent) {
        score += 0.3; // Movement matches reported COG
      } else {
        score -= 0.2; // Movement doesn't match COG - suspicious
      }
      factors++;
    }

    // Speed consistency factor
    if (analysis.speedConsistency !== null) {
      if (analysis.speedConsistency.isConsistent) {
        score += 0.3; // Movement matches reported speed
      } else {
        score -= 0.3; // Movement doesn't match speed - very suspicious
      }
      factors++;
    }

    // SOG change factor - rapid speed changes are common during direction changes
    if (analysis.sogChange > 2) {
      score += 0.1; // Evidence of maneuvering
    }

    return factors > 0 ? Math.max(0, Math.min(1, score / factors + 0.5)) : 0.5;
  }

  /**
   * Log detailed analysis for debugging
   * @private
   */
  _logAnalysis(mmsi, result) {
    const {
      analysis, action, reason, confidence,
    } = result;

    this.logger.debug(
      `🔍 [GPS_ANALYSIS] ${mmsi}: ${action} (${reason}, confidence: ${confidence})\n`
      + `   Distance: ${result.movementDistance.toFixed(0)}m\n`
      + `   COG Change: ${analysis.cogChange?.toFixed(0) || 'N/A'}°\n`
      + `   SOG Change: ${analysis.sogChange?.toFixed(1) || 'N/A'}kn\n`
      + `   Bearing Consistent: ${analysis.bearingConsistency?.isConsistent || 'N/A'}\n`
      + `   Speed Consistent: ${analysis.speedConsistency?.isConsistent || 'N/A'}`,
    );

    if (result.isGPSJump) {
      this.logger.error(
        `🚨 [GPS_JUMP] ${mmsi}: GPS jump detected ${result.movementDistance.toFixed(0)}m - `
        + `COG: ${analysis.cogChange?.toFixed(0) || 'N/A'}°, Speed mismatch: ${!analysis.speedConsistency?.isConsistent}`,
      );
    } else if (result.movementDistance > 500) {
      this.logger.log(
        `🔄 [DIRECTION_CHANGE] ${mmsi}: Large legitimate movement ${result.movementDistance.toFixed(0)}m - `
        + `COG change: ${analysis.cogChange?.toFixed(0) || 'N/A'}°`,
      );
    }
  }
}

module.exports = GPSJumpAnalyzer;
