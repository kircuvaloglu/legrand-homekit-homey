'use strict';

module.exports = {
  // GET /api/app/com.legrand.homekit.local/diagnostics — recent HAP events, subscriptions and connection state
  async getDiagnostics({ homey }) {
    return homey.app.getDiagnostics();
  },
};
