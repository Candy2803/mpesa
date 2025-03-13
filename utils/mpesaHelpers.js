const crypto = require('crypto');
const axios = require('axios');
const mpesaConfig = require('../config/mpesa');

exports.getAccessToken = async () => {
  try {
    const response = await axios.get(mpesaConfig.endpoints.auth(), {
      auth: {
        username: mpesaConfig.consumerKey,
        password: mpesaConfig.consumerSecret,
      },
    });
    return response.data.access_token;
  } catch (error) {
    console.error('Error getting access token:', error);
    throw error;
  }
};

exports.generateTimestamp = () => {
  const date = new Date();
  const year = date.getFullYear().toString();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const hour = date.getHours().toString().padStart(2, '0');
  const minute = date.getMinutes().toString().padStart(2, '0');
  const second = date.getSeconds().toString().padStart(2, '0');
  return `${year}${month}${day}${hour}${minute}${second}`;
};

exports.generatePassword = (timestamp) => {
  // Password = Base64(BusinessShortCode + Passkey + Timestamp)
  const dataToEncode = mpesaConfig.shortcode + mpesaConfig.passkey + timestamp;
  return Buffer.from(dataToEncode).toString('base64');
};
