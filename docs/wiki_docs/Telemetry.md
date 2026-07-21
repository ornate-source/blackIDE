# Telemetry-Free Design

One of the primary core design principles of Black IDE is to provide a clean, telemetry-free development environment that respects developer privacy.

---

## 🚫 Disabled Telemetry & Tracking

Black IDE completely strips telemetry at build-time. We disable all tracking and telemetry-reporting endpoints. By default, the following configuration flags are set to disable collection in the user settings:

```json
{
  "telemetry.telemetryLevel": "off",
  "telemetry.enableCrashReporter": false,
  "telemetry.enableTelemetry": false,
  "telemetry.editStats.enabled": false,
  "workbench.enableExperiments": false,
  "workbench.settings.enableNaturalLanguageSearch": false,
  "workbench.commandPalette.experimental.enableNaturalLanguageSearch": false
}
```

You can review all settings that make online connections by entering the query `@tag:usesOnlineServices` in your settings search bar.

---

## 🔌 Extension Telemetry Warning

> [!WARNING]
> While Black IDE disables core editor telemetry, some third-party extensions install and run their own proprietary telemetry engines that send data to Microsoft or other external services. Black IDE cannot block internal network requests made by compiled third-party extensions.
>
> We recommend checking the settings page of each extension you install to disable telemetry options where available.

---

## 🔄 App and Extension Updates

By default, the application checks for updates to keep you secure. You can manually manage update behaviors with the following preferences:

```json
{
  "update.mode": "manual",
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false
}
```

*Note: On Linux systems, automatic application updates are completely disabled during compilation since updates are handled by the system's package manager.*

---

## 🔍 How to Verify

If you want to verify that no network requests are sent to telemetry endpoints, you can monitor the application's outbound connections using network tools:

* **macOS**: Little Snitch, Wireshark, LuLu
* **Windows**: GlassWire, Wireshark
* **Linux**: Wireshark, OpenSnitch
