const Homey = require('homey');

class LegrandDevice extends Homey.Device {
  log(...args) {
    super.log(...args);
  }

  error(...args) {
    super.error(...args);
  }

  async onInit() {
    this.log(`=== Legrand Device initializing: ${this.getName()} ===`);

    this.store = this.getStore();
    this.gatewayId = this.store.gatewayId;
    this.aid = this.store.aid;

    // Parse stringified JSON from store
    let parsedCharMap = this.store.charMap || {};
    if (typeof parsedCharMap === 'string') {
      try { parsedCharMap = JSON.parse(parsedCharMap); } catch (e) { parsedCharMap = {}; }
    }
    this.charMap = parsedCharMap || {};

    let parsedButtonMap = this.store.buttonMap || {};
    if (typeof parsedButtonMap === 'string') {
      try { parsedButtonMap = JSON.parse(parsedButtonMap); } catch (e) { parsedButtonMap = {}; }
    }
    this.buttonMap = parsedButtonMap || {};

    // Characteristics that support event notifications ("ev" perm). Older devices
    // (paired with an older app version) don't have this in their store — they fall back to
    // subscribing to the full charMap as before.
    let parsedEvIids = this.store.evIids || null;
    if (typeof parsedEvIids === 'string') {
      try { parsedEvIids = JSON.parse(parsedEvIids); } catch (e) { parsedEvIids = null; }
    }
    this.evIids = Array.isArray(parsedEvIids) ? parsedEvIids : null;

    let parsedPairingData = this.store.pairingData;
    if (typeof parsedPairingData === 'string') {
      try { parsedPairingData = JSON.parse(parsedPairingData); } catch (e) { parsedPairingData = null; }
    }

    this.log(`Device metadata: Gateway=${this.gatewayId}, Accessory ID=${this.aid}`);
    this.homey.app.recordDiag(`[DEVICE ${this.getName()}] aid=${this.aid} charMap=${JSON.stringify(this.charMap)} evIids=${JSON.stringify(this.evIids)} buttons=${JSON.stringify(this.buttonMap)}`);

    // Retrieve central HAP connection instance from App class
    this.connection = this.homey.app.getGatewayConnection(
      this.store.gatewayId,
      this.store.ip,
      this.store.port,
      parsedPairingData
    );

    if (this.connection) {
      if (this.evIids) {
        // 1a. Subscribe only to event-capable characteristics (avoids -70406 rejections)
        for (const iid of this.evIids) {
          this.connection.addSubscription(this.aid, Number(iid));
        }
      } else {
        // 1b. Fallback for devices paired with an older app version
        for (const charType of Object.keys(this.charMap)) {
          const iid = this.charMap[charType];
          if (iid) {
            this.connection.addSubscription(this.aid, iid);
          }
        }
      }

      // Also subscribe to all individual wireless buttons
      for (const iid of Object.keys(this.buttonMap)) {
        this.connection.addSubscription(this.aid, Number(iid));
      }
    } else {
      this.error('Could not resolve central HAP Connection. Connection manager not initialized.');
    }

    // 2. Conditionally register capability listeners based on actual support
    if (this.hasCapability('onoff')) {
      this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
    }

    if (this.hasCapability('dim')) {
      this.registerCapabilityListener('dim', this.onCapabilityDim.bind(this));
    }

    if (this.hasCapability('windowcoverings_set')) {
      this.registerCapabilityListener('windowcoverings_set', this.onCapabilityWindowCoveringsSet.bind(this));
    }

    if (this.hasCapability('windowcoverings_state')) {
      this.registerCapabilityListener('windowcoverings_state', this.onCapabilityWindowCoveringsState.bind(this));
    }

    if (this.hasCapability('light_hue')) {
      this.registerCapabilityListener('light_hue', this.onCapabilityLightHue.bind(this));
    }

    if (this.hasCapability('light_saturation')) {
      this.registerCapabilityListener('light_saturation', this.onCapabilityLightSaturation.bind(this));
    }

    if (this.hasCapability('light_temperature')) {
      this.registerCapabilityListener('light_temperature', this.onCapabilityLightTemperature.bind(this));
    }

    if (this.hasCapability('target_temperature')) {
      this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));
    }

    if (this.hasCapability('thermostat_mode')) {
      this.registerCapabilityListener('thermostat_mode', this.onCapabilityThermostatMode.bind(this));
    }

    this._isAvailableFlag = false;

    // Fast init: if the gateway connection is already up (accessories cached), sync and
    // become available right away instead of waiting a fixed 5 seconds. If the connection
    // is still being established, app.js syncs this device via updateDevicesFromAccessories()
    // + setGatewayDevicesAvailable() the moment the connect completes.
    if (this.connection && this.connection.isConnected && this.connection.accessories) {
      this.syncInitialState(this.connection.accessories);
      this.setAvailable().then(() => { this._isAvailableFlag = true; }).catch(this.error);
      this.log(`Device initialization completed (connection warm) for ${this.getName()}`);
    } else {
      // Safety net: never leave the device stuck in a stale "unavailable" state if the connect
      // result arrives shortly after boot — but don't claim "available" while the gateway is
      // unreachable (commands would only fail with "Not connected").
      this._initTimer = this.homey.setTimeout(() => {
        this._initTimer = null;
        if (this.connection && this.connection.isConnected) {
          this.setAvailable().then(() => { this._isAvailableFlag = true; }).catch(this.error);
          if (this.connection.accessories) {
            this.syncInitialState(this.connection.accessories);
          }
        } else {
          const message = (this.connection && this.connection.unavailableMessage) || 'Connecting to gateway...';
          this.setUnavailable(message).catch(this.error);
        }
        this.log(`Device initialization completed (deferred) for ${this.getName()}`);
      }, 5000);
    }
  }

  syncInitialState(accessories) {
    if (!accessories || !Array.isArray(accessories)) return;
    this.log(`[Initial Sync] Syncing state for ${this.getName()} (AID: ${this.aid})`);
    const acc = accessories.find(a => Number(a.aid) === Number(this.aid));
    if (acc && acc.services) {
      for (const service of acc.services) {
        if (service.characteristics) {
          for (const c of service.characteristics) {
            this.onHAPEvent(c.iid, c.value);
          }
        }
      }
    }
  }

  async onDeleted() {
    this.log(`Legrand Device deleted: ${this.getName()}. Removing subscriptions.`);

    if (this._initTimer) {
      this.homey.clearTimeout(this._initTimer);
      this._initTimer = null;
    }

    if (this.connection) {
      if (this.evIids) {
        for (const iid of this.evIids) {
          this.connection.removeSubscription(this.aid, Number(iid));
        }
      } else {
        for (const charType of Object.keys(this.charMap)) {
          const iid = this.charMap[charType];
          if (iid) {
            this.connection.removeSubscription(this.aid, iid);
          }
        }
      }

      for (const iid of Object.keys(this.buttonMap)) {
        this.connection.removeSubscription(this.aid, Number(iid));
      }
    }
  }

  /**
   * Called by app.js when an event is received for this specific device.
   */
  onHAPEvent(iid, value, fromEvent = false) {
    // Check if the event is a mapped wireless button press
    if (this.buttonMap && this.buttonMap[iid] !== undefined) {
      if (value === null || value === undefined) {
        return; // Ignore startup syncs and stateless read nulls
      }
      const buttonNumber = this.buttonMap[iid];
      this.log(`[HAP Push Event] Button ${buttonNumber} (iid=${iid}) pressed, actionCode=${value}`);
      this.triggerButtonPressedFlow(buttonNumber, value);
      
      if (!this._isAvailableFlag) {
        this.setAvailable().then(() => { this._isAvailableFlag = true; }).catch(this.error);
      }
      return;
    }

    // Map HAP iid back to characteristic shorthand (e.g., '25' for On)
    const charType = Object.keys(this.charMap).find(key => Number(this.charMap[key]) === Number(iid));
    if (!charType) {
      // Only real push events are interesting here; initial syncs touch every info characteristic
      if (fromEvent) {
        this.homey.app.recordDiag(`[DEVICE ${this.getName()}] iid ${iid}=${JSON.stringify(value)} not in charMap — ignored`);
      }
      return;
    }

    this.log(`[HAP Push Event] Characteristic '${charType}' updated to:`, value);

    // If the device is receiving real-time events, it's definitely online.
    // Explicitly clear any lingering unavailability states if not already done.
    if (!this._isAvailableFlag) {
      this.setAvailable().then(() => {
        this._isAvailableFlag = true;
      }).catch(this.error);
    }

    switch (charType) {
      case '25': // HAP: On (boolean)
        if (this.hasCapability('onoff')) {
          this.setCapabilityValue('onoff', !!value).catch(this.error);
        }
        break;

      case '8': // HAP: Brightness (0-100)
        if (this.hasCapability('dim')) {
          this.setCapabilityValue('dim', Number(value) / 100).catch(this.error);
        }
        break;

      case '6d': // HAP: CurrentPosition (0-100)
        if (this.hasCapability('windowcoverings_set')) {
          this.setCapabilityValue('windowcoverings_set', Number(value) / 100).catch(this.error);
        }
        break;

      case '7c': // HAP: TargetPosition (0-100)
        if (this.hasCapability('windowcoverings_set')) {
          this.setCapabilityValue('windowcoverings_set', Number(value) / 100).catch(this.error);
        }
        break;

      case '72': // HAP: PositionState (0 = decreasing, 1 = increasing, 2 = stopped)
        if (this.hasCapability('windowcoverings_state')) {
          let state = 'idle';
          if (value === 0) state = 'down';
          else if (value === 1) state = 'up';
          this.setCapabilityValue('windowcoverings_state', state).catch(this.error);
        }
        break;

      case '73': // HAP: ProgrammableSwitchEvent (0 = Single, 1 = Double, 2 = Long Press)
        // Fallback for single-button legacy maps
        this.triggerButtonPressedFlow('1', value);
        break;

      case '13': // HAP: Hue (0-360)
        if (this.hasCapability('light_hue')) {
          this.setCapabilityValue('light_hue', Number(value) / 360).catch(this.error);
        }
        break;

      case '2f': // HAP: Saturation (0-100)
        if (this.hasCapability('light_saturation')) {
          this.setCapabilityValue('light_saturation', Number(value) / 100).catch(this.error);
        }
        break;

      case 'ce': // HAP: Color Temperature (Mireds, 140-500)
        if (this.hasCapability('light_temperature')) {
          const minMired = 140;
          const maxMired = 500;
          const range = maxMired - minMired;
          const miredVal = Math.max(minMired, Math.min(maxMired, Number(value)));
          // Homey: 0 (warmest) to 1 (coolest)
          const homeyTemp = (maxMired - miredVal) / range;
          this.setCapabilityValue('light_temperature', homeyTemp).catch(this.error);
        }
        break;

      case '10': // HAP: Relative Humidity
        if (this.hasCapability('measure_humidity')) {
          this.setCapabilityValue('measure_humidity', Number(value)).catch(this.error);
        }
        break;

      case '11': // HAP: Current Temperature
        if (this.hasCapability('measure_temperature')) {
          this.setCapabilityValue('measure_temperature', Number(value)).catch(this.error);
        }
        break;

      case '35': // HAP: Target Temperature (Thermostat)
      case 'd': // HAP: CoolingThresholdTemperature (HeaterCooler)
      case '12': // HAP: HeatingThresholdTemperature (HeaterCooler)
        if (this.hasCapability('target_temperature')) {
          this.setCapabilityValue('target_temperature', Number(value)).catch(this.error);
        }
        break;

      // NOTE: 'f' (CurrentHeatingCoolingState) is deliberately NOT mapped to thermostat_mode.
      // It reports momentary ACTIVITY (idle=0 while target is heat), which made the Homey UI
      // flap to "off" whenever the thermostat paused heating. Only the TARGET state counts.
      case '33': // HAP: Target Heating Cooling State
        if (this.hasCapability('thermostat_mode')) {
          // 0=Off, 1=Heat, 2=Cool, 3=Auto
          let mode = 'off';
          if (value === 1) mode = 'heat';
          else if (value === 2) mode = 'cool';
          else if (value === 3) mode = 'auto';
          this.setCapabilityValue('thermostat_mode', mode).catch(this.error);
        }
        break;

      case 'b0': // HAP: Active (HeaterCooler)
        this._activeState = Number(value);
        this.updateHeaterCoolerMode();
        break;

      case 'b2': // HAP: TargetHeaterCoolerState (HeaterCooler)
        this._targetState = Number(value);
        this.updateHeaterCoolerMode();
        break;
    }
  }

  updateHeaterCoolerMode() {
    if (this.hasCapability('thermostat_mode')) {
      const active = this._activeState !== undefined ? this._activeState : 1; // Default to active (1)
      const target = this._targetState !== undefined ? this._targetState : 1; // Default to heat (1)
      
      let mode = 'off';
      if (active === 1) {
        if (target === 1) mode = 'heat';
        else if (target === 2) mode = 'cool';
      }
      this.log(`Updating thermostat_mode to: ${mode} (Active: ${active}, TargetState: ${target})`);
      this.setCapabilityValue('thermostat_mode', mode).catch(this.error);
    }
  }

  /**
   * Guard used by every capability listener: gives the user a clear error instead of
   * "Cannot read properties of null" when the connection manager isn't ready.
   */
  _requireConnection() {
    if (!this.connection) {
      throw new Error('Gateway connection is not ready yet. Please try again in a moment.');
    }
    return this.connection;
  }

  // --- Capability Listeners (UI to Legrand Gateway) ---

  async onCapabilityOnOff(value) {
    const onIid = this.charMap['25'];
    if (!onIid) throw new Error('On/Off characteristic not found for this device');

    await this._requireConnection().setCharacteristic(this.aid, onIid, !!value).catch(err => {
      this.error(`Failed to set HAP value for On/Off:`, err.message);
      this.setCapabilityValue('onoff', !value).catch(this.error);
      throw err;
    });
  }

  async onCapabilityDim(value) {
    const dimIid = this.charMap['8'];
    if (!dimIid) throw new Error('Brightness characteristic not found for this device');

    const targetBrightness = Math.round(value * 100);
    await this._requireConnection().setCharacteristic(this.aid, dimIid, targetBrightness).catch(err => {
      this.error(`Failed to set HAP value for Dim:`, err.message);
      throw err;
    });
  }

  async onCapabilityWindowCoveringsSet(value) {
    const targetPosIid = this.charMap['7c'];
    if (!targetPosIid) throw new Error('TargetPosition characteristic not found for this device');

    const targetPosition = Math.round(value * 100);
    await this._requireConnection().setCharacteristic(this.aid, targetPosIid, targetPosition).catch(err => {
      this.error(`Failed to set HAP value for Shutter Position:`, err.message);
      throw err;
    });
  }

  async onCapabilityWindowCoveringsState(value) {
    const targetPosIid = this.charMap['7c'];
    if (!targetPosIid) throw new Error('TargetPosition characteristic not found for this device');

    this.log(`Window covering state command received: ${value}`);

    let targetVal;
    if (value === 'up') {
      targetVal = 100;
    } else if (value === 'down') {
      targetVal = 0;
    } else if (value === 'idle') {
      const currentPos = this.getCapabilityValue('windowcoverings_set') || 0.5;
      targetVal = Math.round(currentPos * 100);
    }

    if (targetVal !== undefined) {
      await this._requireConnection().setCharacteristic(this.aid, targetPosIid, targetVal).catch(err => {
        this.error(`Failed to set HAP value for Shutter State:`, err.message);
        throw err;
      });
    }
  }

  async onCapabilityLightHue(value) {
    const hueIid = this.charMap['13'];
    if (!hueIid) throw new Error('Hue characteristic not found for this device');

    const targetHue = Math.round(value * 360);
    await this._requireConnection().setCharacteristic(this.aid, hueIid, targetHue).catch(err => {
      this.error(`Failed to set HAP value for Hue:`, err.message);
      throw err;
    });
  }

  async onCapabilityLightSaturation(value) {
    const satIid = this.charMap['2f'];
    if (!satIid) throw new Error('Saturation characteristic not found for this device');

    const targetSat = Math.round(value * 100);
    await this._requireConnection().setCharacteristic(this.aid, satIid, targetSat).catch(err => {
      this.error(`Failed to set HAP value for Saturation:`, err.message);
      throw err;
    });
  }

  async onCapabilityLightTemperature(value) {
    const tempIid = this.charMap['ce'];
    if (!tempIid) throw new Error('Color Temperature characteristic not found for this device');

    const minMired = 140;
    const maxMired = 500;
    const range = maxMired - minMired;
    const targetMired = Math.round(maxMired - (value * range));
    await this._requireConnection().setCharacteristic(this.aid, tempIid, targetMired).catch(err => {
      this.error(`Failed to set HAP value for Color Temp:`, err.message);
      throw err;
    });
  }

  async onCapabilityTargetTemperature(value) {
    const targetTempIid = this.charMap['35'];
    const coolingTempIid = this.charMap['d'];
    const heatingTempIid = this.charMap['12'];

    if (!targetTempIid && !coolingTempIid && !heatingTempIid) {
      throw new Error('No target temperature characteristic found for this device');
    }

    // Writes are batched into one HAP PUT; awaiting them lets Homey show a failure.
    const connection = this._requireConnection();
    const writes = [];

    if (targetTempIid) {
      writes.push(connection.setCharacteristic(this.aid, targetTempIid, Number(value)).catch(err => {
        this.error(`Failed to set HAP value for Target Temp:`, err.message);
        throw err;
      }));
    }

    if (coolingTempIid) {
      writes.push(connection.setCharacteristic(this.aid, coolingTempIid, Number(value)).catch(err => {
        this.error(`Failed to set HAP value for Cooling Threshold Temp:`, err.message);
        throw err;
      }));
    }

    if (heatingTempIid) {
      writes.push(connection.setCharacteristic(this.aid, heatingTempIid, Number(value)).catch(err => {
        this.error(`Failed to set HAP value for Heating Threshold Temp:`, err.message);
        throw err;
      }));
    }

    // HeaterCooler units expose both thresholds and may reject one (out of range); only report
    // an error to the user when nothing was applied.
    const results = await Promise.allSettled(writes);
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length === results.length && failures.length > 0) {
      throw failures[0].reason;
    }
  }

  async onCapabilityThermostatMode(value) {
    const targetStateIid = this.charMap['33']; // Standard Thermostat
    const activeIid = this.charMap['b0'];      // HeaterCooler Active
    const targetCoolerIid = this.charMap['b2'];  // HeaterCooler Target State

    if (!targetStateIid && !activeIid) {
      throw new Error('No thermostat mode characteristic found for this device');
    }

    if (targetStateIid) {
      let state = 0; // Off
      if (value === 'heat') state = 1;
      else if (value === 'cool') state = 2;
      else if (value === 'auto') state = 3;

      this._requireConnection().setCharacteristic(this.aid, targetStateIid, state).catch(err => {
        this.error(`Failed to set HAP value for Thermostat Mode:`, err.message);
      });
    }

    if (activeIid) {
      if (value === 'off') {
        this._requireConnection().setCharacteristic(this.aid, activeIid, 0).catch(err => {
          this.error(`Failed to set HAP Active value:`, err.message);
        });
      } else {
        // First activate the unit
        this._requireConnection().setCharacteristic(this.aid, activeIid, 1).catch(err => {
          this.error(`Failed to set HAP Active value:`, err.message);
        });
        
        // Then set the target heating/cooling state
        // HAP TargetHeaterCoolerState: 0=Auto, 1=Heat, 2=Cool
        if (targetCoolerIid) {
          let state = 1; // Heat
          if (value === 'cool') state = 2;
          else if (value === 'auto') state = 0;
          this._requireConnection().setCharacteristic(this.aid, targetCoolerIid, state).catch(err => {
            this.error(`Failed to set HAP TargetHeaterCoolerState:`, err.message);
          });
        }
      }
    }
  }

  /**
   * Triggers the custom Flow Trigger card for wireless buttons
   */
  triggerButtonPressedFlow(buttonNumber, actionCode) {
    // 0 = Single, 1 = Double, 2 = Long Press
    const normalizedActionCode = Number(actionCode);
    const action = normalizedActionCode === 0 ? 'single' : (normalizedActionCode === 1 ? 'double' : 'long');
    const state = {
      button: String(buttonNumber),
      action
    };

    this.log(`Triggering button_pressed flow: button=${state.button}, action=${state.action}`);

    const triggerCard = this.homey.app.buttonPressedTrigger || this.homey.flow.getDeviceTriggerCard('button_pressed');
    triggerCard
      .trigger(this, state, state)
      .then(() => this.log(`Flow button_pressed successfully executed for button ${buttonNumber}.`))
      .catch(err => this.error('Flow trigger execution failed:', err));
  }
}

module.exports = LegrandDevice;
