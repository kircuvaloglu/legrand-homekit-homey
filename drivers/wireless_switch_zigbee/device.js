'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER, BoundCluster } = require('zigbee-clusters');

/**
 * Bound cluster to receive OnOff commands from the Legrand wireless switch (067773 / 752385)
 */
class OnOffBoundCluster extends BoundCluster {
  constructor({ onSetOn, onSetOff, onToggle }) {
    super();
    this._onSetOn = onSetOn;
    this._onSetOff = onSetOff;
    this._onToggle = onToggle;

    // Default ZCL attributes for handshake responses
    this.onOff = false;
    this.globalSceneControl = true;
    this.onTime = 0;
    this.offWaitTime = 0;
  }

  async setOn() {
    if (this._onSetOn) this._onSetOn();
  }

  async setOff() {
    if (this._onSetOff) this._onSetOff();
  }

  async toggle() {
    if (this._onToggle) this._onToggle();
  }

  async offWithEffect() {
    if (this._onSetOff) this._onSetOff();
  }

  async onWithRecallGlobalScene() {
    if (this._onSetOn) this._onSetOn();
  }

  async onWithTimedOff() {
    if (this._onSetOn) this._onSetOn();
  }
}

/**
 * Bound cluster to receive LevelControl (dimming / long press) commands
 */
class LevelControlBoundCluster extends BoundCluster {
  constructor({ onMove, onStop, onStep, onMoveToLevel }) {
    super();
    this._onMove = onMove;
    this._onStop = onStop;
    this._onStep = onStep;
    this._onMoveToLevel = onMoveToLevel;

    // Default ZCL attributes for handshake responses
    this.currentLevel = 254;
    this.remainingTime = 0;
    this.onOffTransitionTime = 0;
    this.onLevel = 254;
    this.onTransitionTime = 0;
    this.offTransitionTime = 0;
  }

  async move(payload) {
    if (this._onMove) this._onMove(payload);
  }

  async moveWithOnOff(payload) {
    if (this._onMove) this._onMove(payload);
  }

  async stop() {
    if (this._onStop) this._onStop();
  }

  async step(payload) {
    if (this._onStep) this._onStep(payload);
  }

  async moveToLevel(payload) {
    if (this._onMoveToLevel) this._onMoveToLevel(payload);
  }

  async moveToLevelWithOnOff(payload) {
    if (this._onMoveToLevel) this._onMoveToLevel(payload);
  }
}

/**
 * Bound cluster to receive Scenes commands
 */
class ScenesBoundCluster extends BoundCluster {
  constructor({ onRecall }) {
    super();
    this._onRecall = onRecall;
    this.sceneCount = 0;
    this.currentScene = 0;
    this.currentGroup = 0;
    this.sceneValid = false;
    this.nameSupport = 0;
  }

  async recall(payload) {
    if (this._onRecall) this._onRecall(payload);
  }
}

/**
 * Bound cluster to receive Identify commands
 */
class IdentifyBoundCluster extends BoundCluster {
  constructor({ onIdentify }) {
    super();
    this._onIdentify = onIdentify;
    this.identifyTime = 0;
  }

  async identify(payload) {
    if (this._onIdentify) this._onIdentify(payload);
  }
}

class WirelessSwitchZigbeeDevice extends ZigBeeDevice {

  async onNodeInit({ zclNode }) {
    this.log(`=== Legrand Wireless Switch initializing: ${this.getName()} ===`);

    this.buttonClickTimers = {};
    this.lastClickTimestamps = {};

    // 1. Register Battery Capability
    if (this.hasCapability('measure_battery')) {
      this.registerCapability('measure_battery', CLUSTER.POWER_CONFIGURATION, {
        get: 'batteryPercentageRemaining',
        report: 'batteryPercentageRemaining',
        reportParser: value => {
          if (typeof value === 'number') {
            // Zigbee standard reports 0-200 (half percentages)
            const percentage = value > 100 ? Math.round(value / 2) : Math.round(value);
            const clamped = Math.min(100, Math.max(0, percentage));
            this.log(`[Zigbee Battery] Remaining: ${clamped}%`);

            if (this.hasCapability('alarm_battery')) {
              this.setCapabilityValue('alarm_battery', clamped <= 15).catch(this.error);
            }
            return clamped;
          }
          return null;
        },
        reportOpts: {
          configureAttributeReporting: {
            minInterval: 300,
            maxInterval: 21600,
            minChange: 2,
          },
        },
      });

      // Also listen for battery voltage reports (2500mV - 3000mV for CR2032)
      if (zclNode.endpoints[1] && zclNode.endpoints[1].clusters[CLUSTER.POWER_CONFIGURATION.NAME]) {
        zclNode.endpoints[1].clusters[CLUSTER.POWER_CONFIGURATION.NAME].on('attr.batteryVoltage', value => {
          if (typeof value === 'number') {
            // Voltage is in 100mV units (e.g. 30 = 3.0V)
            const mV = value * 100;
            const percentage = Math.min(100, Math.max(0, Math.round(((mV - 2500) / 500) * 100)));
            this.log(`[Zigbee Battery Voltage] ${mV}mV -> ${percentage}%`);
            this.setCapabilityValue('measure_battery', percentage).catch(this.error);
            if (this.hasCapability('alarm_battery')) {
              this.setCapabilityValue('alarm_battery', percentage <= 15).catch(this.error);
            }
          }
        });
      }
    }

    // 2. Bind Output Clusters on Endpoint 1
    const ep1 = zclNode.endpoints[1];
    if (ep1) {
      // Bind OnOff Cluster
      ep1.bind(CLUSTER.ON_OFF.NAME, new OnOffBoundCluster({
        onSetOn: () => {
          this.log('[Zigbee Command] Received setOn (Top Button / Button 1)');
          this.handleButtonClick('1');
        },
        onSetOff: () => {
          this.log('[Zigbee Command] Received setOff (Bottom Button / Button 2)');
          this.handleButtonClick('2');
        },
        onToggle: () => {
          this.log('[Zigbee Command] Received toggle (Button 1)');
          this.handleButtonClick('1');
        },
      }));

      // Bind LevelControl Cluster (Long press / hold / release / dim)
      ep1.bind(CLUSTER.LEVEL_CONTROL.NAME, new LevelControlBoundCluster({
        onMove: payload => {
          this.log('[Zigbee Command] Received move:', JSON.stringify(payload));
          const isUp = payload && (payload.moveMode === 'up' || payload.moveMode === 0);
          const button = isUp ? '1' : '2';
          this.triggerButtonFlow(button, 'long');
        },
        onStop: () => {
          this.log('[Zigbee Command] Received stop (Button released)');
          this.triggerButtonFlow('1', 'release');
          this.triggerButtonFlow('2', 'release');
        },
        onStep: payload => {
          this.log('[Zigbee Command] Received step:', JSON.stringify(payload));
          const isUp = payload && (payload.mode === 'up' || payload.mode === 0);
          const button = isUp ? '1' : '2';
          this.triggerButtonFlow(button, 'single');
        },
        onMoveToLevel: payload => {
          this.log('[Zigbee Command] Received moveToLevel:', JSON.stringify(payload));
        },
      }));

      // Bind Scenes Cluster
      ep1.bind(CLUSTER.SCENES.NAME, new ScenesBoundCluster({
        onRecall: payload => {
          this.log('[Zigbee Command] Received scene recall:', JSON.stringify(payload));
          const sceneId = payload && typeof payload.sceneId !== 'undefined' ? String(payload.sceneId) : '1';
          this.triggerButtonFlow(sceneId, 'single');
        },
      }));

      // Bind Identify Cluster
      ep1.bind(CLUSTER.IDENTIFY.NAME, new IdentifyBoundCluster({
        onIdentify: payload => {
          this.log('[Zigbee Command] Received identify:', JSON.stringify(payload));
        },
      }));

      this.log('Bound clusters successfully registered on Endpoint 1.');
    }

    this.log(`Legrand Wireless Switch ${this.getName()} initialization complete.`);
  }

  /**
   * Handle single vs double click detection
   * @param {string} button - '1' for Top (ON), '2' for Bottom (OFF)
   */
  handleButtonClick(button) {
    const now = Date.now();
    const lastClick = this.lastClickTimestamps[button] || 0;
    const diff = now - lastClick;

    if (diff < 400 && this.buttonClickTimers[button]) {
      // Second click within the window: double click
      clearTimeout(this.buttonClickTimers[button]);
      delete this.buttonClickTimers[button];
      this.lastClickTimestamps[button] = 0;
      this.log(`[Zigbee Button] Double click detected on Button ${button}`);
      this.triggerButtonFlow(button, 'double');
    } else {
      // Record click timestamp and set single click timeout
      this.lastClickTimestamps[button] = now;
      if (this.buttonClickTimers[button]) {
        clearTimeout(this.buttonClickTimers[button]);
      }
      this.buttonClickTimers[button] = setTimeout(() => {
        delete this.buttonClickTimers[button];
        this.log(`[Zigbee Button] Single click detected on Button ${button}`);
        this.triggerButtonFlow(button, 'single');
      }, 350);
    }
  }

  /**
   * Trigger Homey Flow card for button actions
   * @param {string} button - '1', '2', etc.
   * @param {string} action - 'single', 'double', 'long', 'release'
   */
  async triggerButtonFlow(button, action) {
    this.log(`[Zigbee Wireless Switch] Triggering Flow: button=${button}, action=${action}`);

    const tokens = {
      button: String(button),
      action: String(action),
    };

    const state = {
      button: String(button),
      action: String(action),
    };

    try {
      const triggerCard = this.homey.app.buttonPressedTrigger || this.homey.flow.getDeviceTriggerCard('button_pressed');
      if (triggerCard) {
        await triggerCard.trigger(this, tokens, state);
        this.log(`[Zigbee Wireless Switch] Flow trigger executed successfully for button ${button} (${action}).`);
      }
    } catch (err) {
      this.error(`[Zigbee Wireless Switch] Failed to trigger flow:`, err.message);
    }
  }

  async onDeleted() {
    this.log(`Legrand Wireless Switch ${this.getName()} removed.`);
    for (const key of Object.keys(this.buttonClickTimers)) {
      if (this.buttonClickTimers[key]) {
        clearTimeout(this.buttonClickTimers[key]);
      }
    }
  }
}

module.exports = WirelessSwitchZigbeeDevice;
