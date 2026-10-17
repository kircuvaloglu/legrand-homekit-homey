'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class WirelessSwitchZigbeeDriver extends ZigBeeDriver {
  async onInit() {
    this.log('Legrand Wireless Switch Zigbee Driver initialized.');
  }
}

module.exports = WirelessSwitchZigbeeDriver;
