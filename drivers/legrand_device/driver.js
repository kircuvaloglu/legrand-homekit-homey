'use strict';

const Homey = require('homey');
// IP-only deep import — see note in app.js (avoids loading BLE/noble at require time)
const HttpClient = require('hap-controller/lib/transport/ip/http-client').default;
const { Bonjour } = require('bonjour-service');

/**
 * Scans the local network for _hap._tcp services (HomeKit devices)
 * and returns an array of { name, host, port, txt } objects.
 */
function discoverHapServices(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const bonjour = new Bonjour();
    const found = [];

    const browser = bonjour.find({ type: 'hap' }, (service) => {
      // Prefer actual IP from addresses array over mDNS hostname
      const addresses = service.addresses || [];
      const ipv4 = addresses.find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a));
      found.push({
        name: service.name,
        host: service.host,
        ip: ipv4 || null,  // actual IPv4 address
        port: service.port,
        txt: service.txt || {}
      });
    });

    setTimeout(() => {
      browser.stop();
      bonjour.destroy();
      resolve(found);
    }, timeoutMs);
  });
}

/**
 * Normalize a HomeKit PIN to XXX-XX-XXX format.
 * Accepts: "12345678", "123-45-678", "123 45 678"
 */
function normalizePIN(raw) {
  const digits = (raw || '').replace(/[^0-9]/g, '');
  if (digits.length !== 8) {
    throw new Error('Invalid PIN format. Please enter 8 digits (e.g. 123-45-678)');
  }
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5, 8)}`;
}

/**
 * Translate HAP pair-setup TLV errors ("M2: Error: 6", "M4: Error: 2", ...) into actionable text.
 */
function describePairSetupError(err) {
  const msg = (err && err.message) || String(err || '');
  const tlv = msg.match(/\bM(\d): Error: (\d+)/);
  const code = tlv ? Number(tlv[2]) : null;

  const resetHint = 'Reset HomeKit on the gateway: press and hold its button for about 10 seconds and release it '
    + 'as soon as the LED flashes for the first time (holding longer may factory-reset the gateway). '
    + 'Wait about a minute, then try again.';

  if (code === 6) {
    return 'This gateway is already paired with another HomeKit controller (Apple Home, another Homey app or '
      + 'an earlier pairing). ' + resetHint;
  }
  if (code === 2 || /Proof verification failed/.test(msg)) {
    return 'The gateway rejected the HomeKit code. Please check the 8-digit HomeKit code on the gateway label '
      + 'or its box (it is not the Wi-Fi or Netatmo code). If you are sure the code is correct, the gateway may '
      + 'still hold an old pairing. ' + resetHint;
  }
  if (code === 3 || code === 5) {
    return 'The gateway blocked pairing after too many failed attempts. Power-cycle the gateway '
      + '(unplug it for 10 seconds), wait a minute and try again with the correct HomeKit code.';
  }
  if (code === 4) {
    return 'The gateway has reached its maximum number of HomeKit controllers. Remove a controller '
      + '(e.g. in Apple Home) or reset HomeKit on the gateway. ' + resetHint;
  }
  if (code === 7) {
    return 'The gateway is busy with another pairing attempt. Close other HomeKit apps, wait a minute and try again.';
  }
  return msg || 'Pairing failed. Please check your PIN code and try again.';
}

class LegrandDeviceDriver extends Homey.Driver {
  async onInit() {
    this.log('Legrand Device Driver initialized.');
  }

  onPair(session) {
    let selectedGateway = null;
    let pairingData = null;

    // STEP 1: login_credentials template — username = IP (optional), password = HomeKit PIN
    session.setHandler('login', async ({ username, password }) => {
      // Find existing pairing data from existing devices if any
      const existingDevices = this.getDevices();
      let cachedPairingData = null;
      let cachedIp = null;
      let cachedPort = null;
      let cachedGatewayId = null;

      for (const d of existingDevices) {
        const store = d.getStore();
        if (store && store.pairingData) {
          try {
            cachedPairingData = JSON.parse(store.pairingData);
            cachedIp = store.ip;
            cachedPort = store.port;
            cachedGatewayId = store.gatewayId;
            break;
          } catch (e) {}
        }
      }

      // Always parse the PIN when one is given: it is needed to pair a second accessory
      // (e.g. a Smarther thermostat next to an already paired gateway).
      let pin = null;
      if (password && String(password).trim()) {
        try {
          pin = normalizePIN(password);
        } catch (e) {
          throw new Error('Please enter your 8-digit HomeKit PIN code (e.g. 123-45-678).');
        }
      }
      if (!cachedPairingData && !pin) {
        throw new Error('Please enter your 8-digit HomeKit PIN code (e.g. 123-45-678).');
      }

      const manualInput = (username || '').trim();

      // Parse optional IP:PORT from the username field
      let manualIp = null;
      let manualPort = null;
      if (manualInput) {
        const parts = manualInput.split(':');
        manualIp = parts[0] || null;
        manualPort = parts[1] ? parseInt(parts[1], 10) : null;
      }

      const hasCachedPairing = !!(cachedGatewayId && cachedPairingData);

      if (hasCachedPairing && !manualIp && !pin) {
        // No PIN and no IP: the user just wants more accessories from the paired gateway.
        // (With a PIN we scan first — the user may be adding a second accessory, e.g. a Smarther.)
        selectedGateway = { id: cachedGatewayId, ip: cachedIp, port: cachedPort };
        pairingData = cachedPairingData;
        this.log('Reusing pairing data of already paired devices.');
        return true;
      }

      this.log('Scanning local network for HomeKit (_hap._tcp) services...');

      // --- mDNS Discovery via bonjour-service ---
      const services = await discoverHapServices(5000);
      this.log(`Found ${services.length} _hap._tcp service(s) on the network:`);
      services.forEach(s => this.log(`  → ${s.name} @ ${s.ip || s.host}:${s.port} (host: ${s.host})`));

      let ip = null;
      let port = null;
      let gatewayId = null;
      let hapTxtId = null; // HAP TXT record "id" — enables IP-change tracking via mDNS discovery

      const txtIdOf = (svc) => {
        const t = svc && svc.txt;
        return t && t.id ? String(t.id).toLowerCase() : null;
      };

      if (manualIp && manualPort) {
        // User provided exact IP:PORT — use it directly
        ip = manualIp;
        port = manualPort;
        gatewayId = `manual:${ip.replace(/\./g, '_')}:${port}`;
        const scanMatch = services.find(s => (s.ip === manualIp || s.host === manualIp) && s.port === manualPort);
        hapTxtId = txtIdOf(scanMatch);
        this.log(`Using manually provided address: ${ip}:${port}`);
      } else if (manualIp) {
        // User provided IP only — find matching service in mDNS results
        const match = services.find(s => s.ip === manualIp || s.host === manualIp || s.host === `${manualIp}.local`);
        if (match) {
          ip = match.ip || manualIp;
          port = match.port;
          gatewayId = `mdns:${ip.replace(/\./g, '_')}:${port}`;
          hapTxtId = txtIdOf(match);
          this.log(`mDNS match found for ${manualIp}: resolved IP=${ip}, port=${port}`);
        } else {
          // No mDNS match — try well-known Legrand/Netatmo ports
          ip = manualIp;
          port = 51827; // HAP default
          gatewayId = `manual:${ip.replace(/\./g, '_')}:${port}`;
          this.log(`No mDNS match for ${manualIp}, defaulting to port ${port}`);
        }
      } else {
        // No manual IP — Auto-detect only unpaired HAP services to support secondary accessories like Smarther Thermostat
        const pairedGatewayIds = new Set(
          existingDevices
            .map(d => d.getStore() && d.getStore().gatewayId)
            .filter(Boolean)
        );

        // HAP ids of accessories we already hold keys for (survives IP changes, unlike gatewayId)
        const pairedHapIds = new Set();
        for (const d of existingDevices) {
          const store = d.getStore() || {};
          if (store.hapId) pairedHapIds.add(String(store.hapId).toLowerCase());
          try {
            const pd = typeof store.pairingData === 'string' ? JSON.parse(store.pairingData) : store.pairingData;
            if (pd && pd.AccessoryPairingID) {
              pairedHapIds.add(Buffer.from(pd.AccessoryPairingID, 'hex').toString('utf8').toLowerCase());
            }
          } catch (e) { /* best effort */ }
        }

        const unpairedServices = services.filter(s => {
          const serviceIp = s.ip || s.host.replace(/\.local\.?$/, '');
          const servicePort = s.port;
          const mdnsId = `mdns:${serviceIp.replace(/\./g, '_')}:${servicePort}`;
          const manualId = `manual:${serviceIp.replace(/\./g, '_')}:${servicePort}`;
          const txtId = txtIdOf(s);
          if (txtId && pairedHapIds.has(txtId)) return false;
          // With an existing pairing, only consider accessories that advertise "not paired" (sf=1),
          // otherwise our own (already paired) gateway would be offered again.
          if (hasCachedPairing && String((s.txt && s.txt.sf) || '') !== '1') return false;
          return !pairedGatewayIds.has(mdnsId) && !pairedGatewayIds.has(manualId);
        });

        const legrandKeywords = ['legrand', 'bticino', 'netatmo', 'gateway', 'thermostat', 'termostat', 'smarther'];
        let match = unpairedServices.find(s => {
          const nameLower = `${s.name || ''} ${(s.txt && s.txt.md) || ''}`.toLowerCase();
          return legrandKeywords.some(k => nameLower.includes(k));
        });

        // If no keyword match: only auto-pick when there is exactly ONE candidate.
        // Blind-picking the first service on networks with other HomeKit gear (Hue,
        // Sonos, ...) would try the Legrand PIN against the wrong device.
        if (!match && unpairedServices.length === 1) match = unpairedServices[0];

        if (!match && hasCachedPairing) {
          // Nothing new to pair: fall back to the gateway we already know (adding more accessories)
          selectedGateway = { id: cachedGatewayId, ip: cachedIp, port: cachedPort };
          pairingData = cachedPairingData;
          this.log('No new unpaired HomeKit accessory found — reusing existing pairing data.');
          return true;
        }

        if (!match) {
          if (unpairedServices.length > 1) {
            const list = unpairedServices
              .map(s => `• ${s.name || 'Unknown'} @ ${s.ip || s.host}:${s.port}`)
              .join('\n');
            throw new Error(
              'Multiple HomeKit devices found. Please enter the IP address of your Legrand/Bticino device in the "Gateway IP" field:\n' + list
            );
          }
          throw new Error(
            'No new HomeKit gateway or thermostat found on your network!\n' +
            'If it is already paired or not showing, please enter its IP address in the "Gateway IP" field.'
          );
        }

        // Use real IP address from addresses[], fall back to stripping .local from hostname
        ip = match.ip || match.host.replace(/\.local\.?$/, '');
        port = match.port;
        gatewayId = `mdns:${ip.replace(/\./g, '_')}:${port}`;
        hapTxtId = txtIdOf(match);
        this.log(`Auto-detected unpaired accessory: ${match.name} @ ${ip}:${port} (resolved from ${match.host})`);
      }

      selectedGateway = { id: gatewayId, ip, port, hapId: hapTxtId };

      // Check if we already paired during this session (keys in RAM) to avoid Error: 6
      const existingConnection = this.homey.app.gateways.get(gatewayId);
      if (existingConnection && existingConnection.pairingData) {
        this.log(`Existing pairing data found in memory for ${gatewayId}. Bypassing pairSetup to avoid M2: Error: 6.`);
        pairingData = existingConnection.pairingData;
        return true;
      }

      // Check if we have matching pairing data in cached devices
      if (cachedGatewayId === gatewayId && cachedPairingData) {
        this.log(`Reusing stored pairing data from Homey database for ${gatewayId}. Bypassing pairSetup.`);
        pairingData = cachedPairingData;
        this.homey.app.getGatewayConnection(gatewayId, ip, port, pairingData);
        return true;
      }

      if (!pin) {
        // Reached the fresh-pairing path without a usable PIN (e.g. cached data exists
        // but belongs to a different accessory) — fail with a clear message instead of pairSetup(null).
        throw new Error('This device requires its own HomeKit PIN. Please enter the 8-digit PIN code (e.g. 123-45-678).');
      }

      this.log(`Starting HAP pairSetup with ${ip}:${port}...`); // PIN intentionally NOT logged

      const client = new HttpClient('com.legrand.homekit.local', ip, port);
      let timeoutTimer = null;
      try {
        // Wrap pairSetup with a 15s timeout (mDNS already took 5s)
        const pairPromise = client.pairSetup(pin);
        const timeoutPromise = new Promise((_, reject) => {
          timeoutTimer = setTimeout(() => reject(new Error(
            `Connection timed out to ${ip}:${port}. If the IP is correct, try entering it with port as ${ip}:PORT`
          )), 15000);
        });

        await Promise.race([pairPromise, timeoutPromise]);

        pairingData = client.getLongTermData();
        this.log('HAP pairing completed.');
        this.homey.app.getGatewayConnection(gatewayId, ip, port, pairingData);
        return true;
      } catch (err) {
        this.error('pairSetup failed:', err.message || err);
        throw new Error(describePairSetupError(err));
      } finally {
        clearTimeout(timeoutTimer);
        // Never leave the pair-setup socket open: it occupies one of the gateway's few HAP slots
        Promise.resolve(client.close()).catch(() => {});
      }
    });

    // STEP 2: list_devices populates the Homey device list
    session.setHandler('list_devices', async () => {
      if (!selectedGateway || !pairingData) {
        throw new Error('Pairing not complete. Please go back and enter your PIN first.');
      }

      this.log('Retrieving bridged accessories from Legrand Gateway...');
      try {
        const connection = this.homey.app.getGatewayConnection(
          selectedGateway.id,
          selectedGateway.ip,
          selectedGateway.port,
          pairingData
        );

        const accessoriesResponse = await connection.getAccessories();
        const accessories = accessoriesResponse.accessories || accessoriesResponse;

        if (this.homey.settings.get('debugLogs')) {
          this.log('--- ACCESSORIES DUMP ---');
          this.log(JSON.stringify(accessories, null, 2));
          this.log('------------------------');
        }

        if (!Array.isArray(accessories)) {
          throw new Error('Accessories response has invalid HAP structure.');
        }

        const devicesList = [];

        for (const acc of accessories) {
          const services = acc.services || [];
          
          // Standalone accessories (like Smarther Thermostat) have aid = 1 but contain primary services
          // like Thermostat (0000004A) or HeaterCooler (000000BC). Bridges have aid = 1 and only AccessoryInformation.
          const hasPrimaryService = services.some(s => {
            const type = s.type.toUpperCase();
            return type.includes('00000043') || // Lightbulb
                   type.includes('00000047') || // Outlet
                   type.includes('00000049') || // Switch
                   type.includes('0000008C') || // Window Covering
                   type.includes('0000004A') || // Thermostat
                   type.includes('000000BC');   // HeaterCooler
          });

          if (Number(acc.aid) === 1 && !hasPrimaryService) {
            continue; // Skip the bridge node itself
          }
          let deviceClass = 'other';
          let deviceCapabilities = [];
          let primaryService = null;

          // Extract name and model from AccessoryInformation service
          const infoService = services.find(s => s.type.toUpperCase().includes('0000003E'));
          let model = 'Bridged Device';
          let name = `Device #${acc.aid}`;

          if (infoService && infoService.characteristics) {
            const modelChar = infoService.characteristics.find(c => c.type.toUpperCase().includes('00000021'));
            const nameChar = infoService.characteristics.find(c => c.type.toUpperCase().includes('00000023'));
            if (modelChar && modelChar.value) model = modelChar.value;
            if (nameChar && nameChar.value) name = nameChar.value;
          }

          // Match primary HAP service type
          for (const s of services) {
            const type = s.type.toUpperCase();
            if (type.includes('00000043')) { // Lightbulb
              primaryService = s;
              deviceClass = 'light';
              deviceCapabilities = ['onoff'];
              const chars = s.characteristics || [];
              const hasDim = chars.some(c => c.type.toUpperCase().includes('00000008'));
              if (hasDim) deviceCapabilities.push('dim');
              const hasHue = chars.some(c => c.type.toUpperCase().includes('00000013'));
              const hasSat = chars.some(c => c.type.toUpperCase().includes('0000002F'));
              const hasTemp = chars.some(c => c.type.toUpperCase().includes('000000CE'));
              if (hasHue && hasSat) deviceCapabilities.push('light_hue', 'light_saturation');
              if (hasTemp) deviceCapabilities.push('light_temperature');
              break;
            } else if (type.includes('00000047')) { // Outlet
              primaryService = s; deviceClass = 'socket'; deviceCapabilities = ['onoff']; break;
            } else if (type.includes('00000049')) { // Switch
              primaryService = s; deviceClass = 'switch'; deviceCapabilities = ['onoff']; break;
            } else if (type.includes('0000008C')) { // Window Covering
              primaryService = s; deviceClass = 'blinds';
              deviceCapabilities = ['windowcoverings_set', 'windowcoverings_state']; break;
            } else if (type.includes('00000089')) { // Stateless Programmable Switch
              primaryService = s; deviceClass = 'sensor'; deviceCapabilities = []; break;
            } else if (type.includes('0000004A') || type.includes('000000BC')) { // Thermostat or HeaterCooler
              primaryService = s; deviceClass = 'thermostat'; 
              deviceCapabilities = ['measure_temperature', 'target_temperature', 'thermostat_mode'];
              const hasHumidity = services.some(srv => srv.type.toUpperCase().includes('00000082'));
              if (hasHumidity) deviceCapabilities.push('measure_humidity');
              break;
            }
          }

          if (primaryService) {
            const charMap = {};
            const evIids = []; // only characteristics that actually support event notifications
            const buttonMap = {};
            let buttonIndex = 1;

            // Gather characteristics from all services to support humidity and button mappings
            services.forEach(srv => {
              const isButtonService = srv.type.toUpperCase().includes('00000089');
              let eventIid = null;
              let labelIndex = null;

              (srv.characteristics || []).forEach(c => {
                const shortType = c.type.split('-')[0].replace(/^0+/, '').toLowerCase();
                charMap[shortType] = c.iid;

                // Subscribing to non-"ev" characteristics only produces -70406 errors from the gateway
                if (Array.isArray(c.perms) && c.perms.includes('ev')) {
                  evIids.push(c.iid);
                }

                if (isButtonService) {
                  if (shortType === '73') eventIid = c.iid;
                  if (shortType === 'cb') labelIndex = c.value; // ServiceLabelIndex (0xCB)
                }
              });

              if (isButtonService && eventIid) {
                const bNum = labelIndex !== null && labelIndex !== undefined ? labelIndex : buttonIndex;
                buttonMap[eventIid] = String(bNum);
                buttonIndex++;
              }
            });

            devicesList.push({
              name: name || `${model} (ID: ${acc.aid})`,
              class: deviceClass,
              capabilities: deviceCapabilities,
              data: { id: `${selectedGateway.id}:${acc.aid}` },
              store: {
                gatewayId: selectedGateway.id,
                hapId: selectedGateway.hapId || '',
                aid: acc.aid,
                ip: selectedGateway.ip,
                port: selectedGateway.port,
                pairingData: JSON.stringify(pairingData),
                deviceClass,
                charMap: JSON.stringify(charMap),
                evIids: JSON.stringify(evIids),
                buttonMap: JSON.stringify(buttonMap)
              }
            });
          }
        }

        this.log(`Found ${devicesList.length} ready-to-add child accessories.`);
        return devicesList;
      } catch (err) {
        this.error('Accessory list retrieval failed:', err.message);
        throw new Error('Could not retrieve Legrand devices. Try restarting the Gateway.');
      }
    });
  }
}

module.exports = LegrandDeviceDriver;
