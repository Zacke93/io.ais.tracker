'use strict';

const CountTextHelper = require('./CountTextHelper');

/**
 * MessageBuilder - Centralized message generation for bridge text
 * Eliminates duplicated message patterns throughout BridgeTextService
 *
 * REFACTORING: Extracts 20+ duplicated message patterns into reusable methods
 * BEFORE: Message strings duplicated across 10+ methods
 * AFTER: Single source of truth for all message formats
 */
class MessageBuilder {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Build ETA suffix
   * @param {string|null} etaText - Formatted ETA text
   * @param {Object} options - Options for ETA suffix
   * @param {string} options.prefix - Prefix before ETA (default: "beräknad broöppning")
   * @param {string} options.targetBridge - Target bridge name for intermediate messages
   * @returns {string} Formatted ETA suffix, or empty string if no ETA
   */
  buildETASuffix(etaText, options = {}) {
    if (!etaText) return '';

    const { prefix = 'beräknad broöppning', targetBridge = null } = options;

    if (targetBridge) {
      return `, ${prefix} av ${targetBridge} ${etaText}`;
    }
    return `, ${prefix} ${etaText}`;
  }

  /**
   * Build single vessel message
   * @param {string} action - Action verb (e.g., "närmar sig", "inväntar broöppning vid")
   * @param {string} bridge - Bridge name
   * @param {Object} context - Additional context
   * @param {string} context.eta - Formatted ETA text
   * @param {string} context.targetBridge - Target bridge (for "på väg mot" messages)
   * @param {string} context.etaPrefix - Custom ETA prefix
   * @returns {string} Formatted message
   */
  buildSingle(action, bridge, context = {}) {
    const { eta = null, targetBridge = null, etaPrefix = 'beräknad broöppning' } = context;

    // Build ETA suffix
    let etaSuffix = '';
    if (eta) {
      if (targetBridge && targetBridge !== bridge) {
        etaSuffix = `, ${etaPrefix} av ${targetBridge} ${eta}`;
      } else {
        etaSuffix = `, ${etaPrefix} ${eta}`;
      }
    }

    // Build main message
    if (targetBridge && targetBridge !== bridge) {
      return `En båt ${action} ${bridge} på väg mot ${targetBridge}${etaSuffix}`;
    }
    return `En båt ${action} ${bridge}${etaSuffix}`;
  }

  /**
   * Build multiple vessels message
   * @param {number} count - Total number of vessels
   * @param {string} action - Action verb
   * @param {string} bridge - Bridge name
   * @param {Object} context - Additional context
   * @param {string} context.eta - Formatted ETA text
   * @param {string} context.targetBridge - Target bridge
   * @param {number} context.additionalCount - Number of additional vessels (if different from count-1)
   * @returns {string} Formatted message
   */
  buildMultiple(count, action, bridge, context = {}) {
    const { eta = null, targetBridge = null, additionalCount = count - 1 } = context;

    const countText = CountTextHelper.getCountText(count);
    const additionalText = CountTextHelper.buildAdditionalText(additionalCount);
    const etaSuffix = this.buildETASuffix(eta, { targetBridge });

    // All vessels with same status
    if (additionalCount === 0 || additionalCount === count - 1) {
      if (targetBridge && targetBridge !== bridge) {
        return `${countText} båtar ${action} ${bridge} på väg mot ${targetBridge}${etaSuffix}`;
      }
      return `${countText} båtar ${action} ${bridge}${etaSuffix}`;
    }

    // Leading vessel + additional vessels
    if (targetBridge && targetBridge !== bridge) {
      return `En båt ${action} ${bridge} på väg mot ${targetBridge}${additionalText}${etaSuffix}`;
    }
    return `En båt ${action} ${bridge}${additionalText}${etaSuffix}`;
  }

  /**
   * Build "inväntar broöppning" message for target bridge
   * @param {number} count - Number of vessels
   * @param {string} bridge - Bridge name
   * @returns {string} Formatted waiting message (NO ETA for target bridges)
   */
  buildWaitingAtTargetBridge(count, bridge) {
    if (count === 1) {
      return `En båt inväntar broöppning vid ${bridge}`;
    }
    return `${CountTextHelper.getCountText(count)} båtar inväntar broöppning vid ${bridge}`;
  }

  /**
   * Build "inväntar broöppning av" message for intermediate bridge
   * @param {number} count - Number of vessels
   * @param {string} intermediateBridge - Intermediate bridge name
   * @param {string} targetBridge - Target bridge name
   * @param {string} eta - Formatted ETA to target bridge
   * @returns {string} Formatted waiting message (WITH ETA to target)
   */
  buildWaitingAtIntermediateBridge(count, intermediateBridge, targetBridge, eta = null) {
    const etaSuffix = this.buildETASuffix(eta);

    if (count === 1) {
      return `En båt inväntar broöppning av ${intermediateBridge} på väg mot ${targetBridge}${etaSuffix}`;
    }
    return `${CountTextHelper.getCountText(count)} båtar inväntar broöppning av ${intermediateBridge} på väg mot ${targetBridge}${etaSuffix}`;
  }

  /**
   * Build "broöppning pågår" message
   * @param {string} bridge - Bridge name
   * @param {Object} context - Additional context
   * @param {string} context.targetBridge - Target bridge for intermediate bridges
   * @param {string} context.eta - ETA to target bridge (for intermediate)
   * @param {number} context.additionalCount - Additional vessels
   * @returns {string} Formatted under-bridge message
   */
  buildUnderBridge(bridge, context = {}) {
    const { targetBridge = null, eta = null, additionalCount = 0 } = context;

    const additionalText = CountTextHelper.buildAdditionalText(additionalCount);

    // Intermediate bridge: show target and ETA
    if (targetBridge && targetBridge !== bridge) {
      const etaSuffix = this.buildETASuffix(eta, { targetBridge, prefix: 'beräknad broöppning av' });
      return `Broöppning pågår vid ${bridge}${additionalText}${etaSuffix}`;
    }

    // Target bridge: no ETA
    return `Broöppning pågår vid ${bridge}${additionalText}`;
  }

  /**
   * Build "precis passerat" message
   * @param {string} passedBridge - Bridge that was just passed
   * @param {string} targetBridge - Next target bridge
   * @param {string} eta - ETA to target bridge
   * @param {Object} context - Additional context
   * @param {number} context.additionalCount - Additional vessels
   * @returns {string} Formatted passed message
   */
  buildPassed(passedBridge, targetBridge, eta = null, context = {}) {
    const { additionalCount = 0 } = context;

    const etaSuffix = this.buildETASuffix(eta);
    const additionalText = CountTextHelper.buildAdditionalText(additionalCount);

    return `En båt har precis passerat ${passedBridge} på väg mot ${targetBridge}${additionalText}${etaSuffix}`;
  }

  /**
   * Build "närmar sig" message
   * @param {string} bridge - Bridge name
   * @param {Object} context - Additional context
   * @param {string} context.targetBridge - Target bridge (if different)
   * @param {string} context.eta - Formatted ETA
   * @param {number} context.additionalCount - Additional vessels
   * @returns {string} Formatted approaching message
   */
  buildApproaching(bridge, context = {}) {
    const { targetBridge = null, eta = null, additionalCount = 0 } = context;

    const etaSuffix = this.buildETASuffix(eta);
    const additionalText = CountTextHelper.buildAdditionalText(additionalCount);

    if (targetBridge && targetBridge !== bridge) {
      return `En båt närmar sig ${bridge} på väg mot ${targetBridge}${additionalText}${etaSuffix}`;
    }
    return `En båt närmar sig ${bridge}${additionalText}${etaSuffix}`;
  }

  /**
   * Build "på väg mot" message (for en-route vessels)
   * @param {string} targetBridge - Target bridge name
   * @param {string} eta - Formatted ETA
   * @param {Object} context - Additional context
   * @param {number} context.count - Total vessels (for multi-vessel)
   * @param {number} context.additionalCount - Additional vessels
   * @returns {string} Formatted en-route message
   */
  buildEnRoute(targetBridge, eta = null, context = {}) {
    const { count = 1, additionalCount = 0 } = context;

    const etaSuffix = this.buildETASuffix(eta);
    const additionalText = CountTextHelper.buildAdditionalText(additionalCount);

    if (count === 1) {
      return `En båt på väg mot ${targetBridge}${additionalText}${etaSuffix}`;
    }
    return `${CountTextHelper.getCountText(count)} båtar på väg mot ${targetBridge}${etaSuffix}`;
  }
}

module.exports = MessageBuilder;
