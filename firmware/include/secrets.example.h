#pragma once

// Copy this file to secrets.h. Do not commit secrets.h.
#define WIFI_SSID "your-wifi"
#define WIFI_PASSWORD "your-wifi-password"

// No trailing slash, e.g. https://smart-cb.example.workers.dev
#define SMART_CB_API_BASE "https://your-worker.workers.dev"
#define SMART_CB_DEVICE_ID "dev_replace_me"
#define SMART_CB_DEVICE_KEY "replace-with-key-shown-once-in-dashboard"

// Root CA that signs the Worker hostname certificate. Keep it current when the
// certificate chain changes. Never replace TLS validation with setInsecure().
static const char ROOT_CA_CERT[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
PASTE_ROOT_CA_CERTIFICATE_HERE
-----END CERTIFICATE-----
)EOF";
