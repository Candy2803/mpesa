const axios = require('axios');
const moment = require('moment');
const mpesaConfig = require('../config/mpesa');

exports.getAccessToken = async () => {
  try {
    const auth = Buffer.from(`${mpesaConfig.consumerKey}:${mpesaConfig.consumerSecret}`).toString('base64');
    
    const response = await axios.get(mpesaConfig.endpoints.auth(), {
      headers: {
        Authorization: `Basic ${auth}`
      }
    });
    
    return response.data.access_token;
  } catch (error) {
    console.error('Error getting access token:', error);
    throw error;
  }
};

exports.generateTimestamp = () => {
  return moment().format('YYYYMMDDHHmmss');
};

exports.generatePassword = (timestamp) => {
  const shortcode = mpesaConfig.shortcode;
  const passkey = mpesaConfig.passkey;
  
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
};