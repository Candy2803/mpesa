const dotenv = require('dotenv');
dotenv.config();

module.exports = {
  consumerKey: process.env.MPESA_CONSUMER_KEY,
  consumerSecret: process.env.MPESA_CONSUMER_SECRET,
  passkey: process.env.MPESA_PASSKEY,
  // Fixed production paybill
  shortcode: "500005",
  // Set environment to production
  environment: process.env.MPESA_ENV || 'production',
  callbackUrl: process.env.CALLBACK_URL,
  endpoints: {
    auth: function() {
      return this.environment === 'production'
        ? 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
        : 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';
    },
    stkPush: function() {
      return this.environment === 'production'
        ? 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
        : 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest';
    }
  }
};
