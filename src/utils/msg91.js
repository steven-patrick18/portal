// Backward-compat shim. The actual SMS dispatcher is now in ./sms.js
// which picks the provider (gateway / msg91 / off) from app_settings.
// Anything that still imports './msg91' transparently uses the new code.
const { sendSMS } = require('./sms');

// WhatsApp via MSG91 was barely used; keep a no-op stub so legacy callers
// don't crash if they import sendWhatsApp.
async function sendWhatsApp(args) {
  return sendSMS({ ...args, channel: 'whatsapp' });   // unified path will treat it as SMS-via-current-provider
}

module.exports = { sendSMS, sendWhatsApp };
