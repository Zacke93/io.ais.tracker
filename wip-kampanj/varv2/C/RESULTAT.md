# RESULTAT — familj C, M3 ÅTERFÖDD-DÖDBAND (varv 2, 2026-11-09)

**Rotorsaken är bekräftad** i världarna 756 (F05), 1913 och 977 (DESIGN.md §1). En återfödd båt med kurs i dödbandet
fick ingen målbro (c14938f:VDS:4645–4651). Svepets lås kom efter `_observeBridgeOpening` (app.js:3056 före :3068). Det
blev ingen arm och ingen deadline i tystnaden, och nästa fix hjälpte inte, eftersom FP8 bara följer låset när kursen saknas.

**Rättningen** (`f62aea8` och `19b3bfa` i C/wt; revision 2, `d190e9c`, ändrar bara kommentarer, dokument och
test). I ny-båtsgrenen avgör `_rebirthTransitDirection` riktningen ur K1 mot sist kända position i samma meddelande:
kursen i ett dödband, sog ≥ 2 kn, mätningen från detta meddelande, nettofart i nordled ≥ 2 kn och kursens sida rätt
(östra dödbandet norrut, västra söderut). Riktningen låses, `_calculateTargetBridge(vessel, dir)` väljer målbron och
kajgrinden prövas mot den. Annars släpps låset.

**Tröskeln och F18.** 2 kn är `FIX_D_MIN_SOG`, inget nytt tal. Med sog ≥ 2 och dödbandskurs låser 2 kn 56 av 121
transitpar i fältbanken och 0 av 50 övriga (högsta 1,68 kn); NORDIC SOLA (41h) ligger 2,4× under. Riktningen kommer ur
en mätt förflyttning. Kraven stoppar de konstruerade varianterna, men inte fyra grannklasser (granskningen L1): W1
vändning vid återfödelsen, W2/W3 första ankomst till Kajen eller Gästhamnen utan kajhistorik, W4 GPS-hopp med fartspik
och W5 V8. De ger exakt samma utfall som en tvilling med kurs i banden ger på c14938f, alltså ett falsklarm i stället för
en missad öppning. W1 och W3 är låsta i test (steg 7).

**Ordningen mot svepet:** låser svepet alls, låser det samma riktning, och R1/F15 hade inte släppt låset. Saknar fönstret
kandidatbroar låser svepet inte; då är M3:s lås det enda, och det släpps när ingen målbro blir.

**Test:** `tests/m3-aterfodd-dodband-2026-11-09.test.js`, 26 test, varav 17 röda på c14938f. Två syntetiska scenarier
är röda på c14938f; de övriga 74 ger identiska rader.

**Mätningar** (C/batt för 19b3bfa; revision 2: jest för M3-filen 26/26 och lint gröna):
- Batteriet: alla tretton steg har slutkod 0. Banken är bitlik mot c14938f, 26/26 med och utan monitoring. FACIT.md:
  inget flyttas.
- hunt --repro: BORTA för 756 (fyndet och kortet), 1913 och 977. Övriga 22 tA- och 26 tB-kort som på c14938f.
- quick: samma fyra kandidatkluster, inga nya.
  - Värld 217: DESIGN-utslaget på fruset fix försvinner (rättare).
  - Värld 235: EMA startar tidigare, så ETA:n blir cirka 1 min sämre (4→10→4). ETA-koden är orörd.

**Öppna frågor:**
1. 977 ligger 1,2 % över ribban.
2. Saknad kurs och kontinuerligt spårade båtar omfattas inte; 54 % av dödbandstransiterna ligger under 2 kn.
3. V8 är en känd gräns. Spara fixTs/fixFeed i posten senare.
4. Kajgrinden i ACCELERATED är stum redan på c14938f (L4).
