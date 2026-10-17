# Legrand with HomeKit Code

Homey Pro app for local control of Legrand and BTicino devices.

## Modes

1. **HomeKit gateway (local HAP):** connects to a Legrand gateway or a BTicino Smarther thermostat on the local network using the device's 8-digit HomeKit code.
2. **Direct Zigbee (experimental):** pairs the Legrand wireless switch (067773 / 752385) directly to Homey's Zigbee radio, without a gateway.

## Supported devices

### HomeKit gateway

- Lights and dimmers (on/off, dim, hue/saturation, color temperature)
- Smart outlets (on/off)
- Roller shutters (position 0-100%, movement state)
- BTicino Smarther thermostats (target temperature, current temperature, humidity, mode)
- Scene switches that report HomeKit button events

### Direct Zigbee

- Legrand wireless switch 067773 / 752385
  - Single press (top = button 1, bottom = button 2)
  - Double press
  - Long press and release
  - Battery level and low battery alarm

## Pairing the wireless switch over Zigbee

1. In the Homey app, tap **+** and choose **Legrand with HomeKit Code** > **Wireless Switch (Zigbee)**.
2. Remove the rocker of the switch to reach the reset (gear) button.
3. Hold the reset button until the LED briefly turns red, then release it.
4. Homey interviews the device and adds it.

## Diagnostics

The app keeps the most recent HomeKit events, subscriptions and connection changes in memory:

```
homey api raw --path /api/app/com.legrand.homekit.local/diagnostics --json
```
