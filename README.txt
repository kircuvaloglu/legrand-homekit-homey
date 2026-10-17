Legrand with HomeKit Code

Control Legrand and BTicino devices locally from Homey Pro. The app talks to your Legrand gateway (and standalone devices such as the BTicino Smarther thermostat) over the local network using the HomeKit Accessory Protocol. You only need the device's 8-digit HomeKit code. No cloud account is required.

Features
- Local control: everything runs on your Homey Pro, no internet connection or cloud account needed.
- Real-time status: changes made with the physical wall switches or the Home + Control app are pushed to Homey right away.
- Gateway and standalone devices: devices behind the Legrand gateway as well as standalone HomeKit devices are supported.
- Automatic recovery: if the gateway restarts or changes IP address, the app reconnects on its own. While the gateway is unreachable, devices are shown as unavailable with the reason.

Supported devices
- Lights and dimmers: on/off, dim level, hue/saturation and color temperature (when the device supports it).
- Smart outlets: on/off.
- Roller shutters: position (0-100%) and movement state.
- BTicino Smarther thermostats: current temperature, target temperature, mode (off/heat/cool) and humidity.
- Scene switches: a Flow trigger for single, double and long presses, for switches that report button events over HomeKit. Battery-powered wireless switches behind the gateway may not report presses.
- Experimental: Legrand wireless switch (067773 / 752385) paired directly to Homey's Zigbee radio, without a gateway.

Not available over HomeKit
- Power and energy consumption of outlets.
- Slat tilt of shutters.

Setup
1. Make sure the Legrand gateway or Smarther thermostat is connected to your Wi-Fi with the Legrand / BTicino app, and have its 8-digit HomeKit code ready. It is printed on the device, in the manual or on the box.
2. A HomeKit device can only be paired with one controller. If it is paired with Apple Home, remove it there first, or reset HomeKit on the gateway.
3. In the Homey app, go to Devices, tap +, and choose "Legrand with HomeKit Code".
4. Leave the Gateway IP field empty for automatic discovery, or enter the device's IP address if you have several HomeKit devices on your network.
5. Enter the HomeKit code (for example 123-45-678) and continue.
6. Select the devices you want to add.

Troubleshooting
- "M2: Error 6": the gateway is already paired with another controller. Reset HomeKit on the gateway: hold its button for about 10 seconds and release it as soon as the LED flashes for the first time. Holding it longer may factory-reset the gateway.
- "M4: Error 2": the HomeKit code was rejected. Check the code on the gateway label or box.
- Devices stay unavailable with "The gateway refuses HomeKit connections": unplug the gateway for 10 seconds and plug it back in.
