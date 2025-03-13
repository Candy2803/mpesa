const Transaction = require('../models/Transaction');
const mpesaHelpers = require('../utils/mpesaHelpers');
const mpesaConfig = require('../config/mpesa');
const axios = require('axios');

// Initiate STK Push
exports.initiateSTKPush = async (req, res) => {
  try {
    console.log("Request Body:", req.body);
    const { phoneNumber, amount, reference, description } = req.body;
    
    // Validate request
    if (!phoneNumber || !amount) {
      return res.status(400).json({ error: 'Phone number and amount are required' });
    }
    
    // Format phone number to 2547XXXXXXXX
    let formattedPhone = phoneNumber.trim();
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '254' + formattedPhone.substring(1);
    } else if (formattedPhone.startsWith('+254')) {
      formattedPhone = formattedPhone.substring(1);
    } else if (!formattedPhone.startsWith('254')) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }
    if (formattedPhone.length !== 12) {
      return res.status(400).json({ error: 'Phone number must be 12 digits in the format 2547XXXXXXXX' });
    }
    
    // Get access token from M-PESA
    const token = await mpesaHelpers.getAccessToken();
    
    // Generate timestamp and password
    const timestamp = mpesaHelpers.generateTimestamp();
    const password = mpesaHelpers.generatePassword(timestamp);
    
    // Prepare STK Push request using fixed paybill and account number
    const stkPushRequestBody = {
      BusinessShortCode: "500005",          // Fixed paybill
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: formattedPhone,
      PartyB: "500005",                     // Fixed paybill as PartyB
      PhoneNumber: formattedPhone,
      CallBackURL: mpesaConfig.callbackUrl,
      AccountReference: "BA0619032",        // Fixed account number
      TransactionDesc: description || 'Payment'
    };
    
    // Make STK Push request using production endpoint
    const response = await axios.post(
      mpesaConfig.endpoints.stkPush(),
      stkPushRequestBody,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    // Save transaction to the database
    const transaction = new Transaction({
      phoneNumber: formattedPhone,
      amount,
      reference: reference || 'Payment',
      description: description || 'Payment',
      merchantRequestID: response.data.MerchantRequestID,
      checkoutRequestID: response.data.CheckoutRequestID,
      responseCode: response.data.ResponseCode,
      responseDescription: response.data.ResponseDescription,
      customerMessage: response.data.CustomerMessage,
    });
    
    await transaction.save();
    
    return res.status(200).json({
      success: true,
      message: 'STK Push initiated successfully',
      data: response.data,
      transactionId: transaction._id
    });
    
  } catch (error) {
    console.error('Error initiating STK Push:', error);
    if (error.code === 11000 && error.keyPattern && error.keyPattern.checkoutRequestID) {
      return res.status(409).json({
        success: false,
        message: 'Transaction already initiated',
        error: 'Duplicate transaction request'
      });
    }
    
    return res.status(500).json({
      success: false,
      message: 'Failed to initiate STK Push',
      error: error.response ? error.response.data : error.message
    });
  }
};

// Handle callback from M-PESA
exports.handleCallback = async (req, res) => {
  try {
    const callbackData = req.body;
    console.log('M-PESA Callback Data:', JSON.stringify(callbackData, null, 2));
    
    if (!callbackData.Body || !callbackData.Body.stkCallback) {
      return res.status(400).json({ error: 'Invalid callback data' });
    }
    
    const stkCallback = callbackData.Body.stkCallback;
    const checkoutRequestID = stkCallback.CheckoutRequestID;
    
    // Find transaction by checkoutRequestID
    let transaction = await Transaction.findOne({ checkoutRequestID });
    if (!transaction) {
      console.log('Transaction not found for CheckoutRequestID:', checkoutRequestID);
      transaction = await Transaction.findOne({ merchantRequestID: stkCallback.MerchantRequestID });
      if (!transaction) {
        if (stkCallback.ResultCode === 0 && stkCallback.CallbackMetadata) {
          const callbackItems = stkCallback.CallbackMetadata.Item;
          const mpesaReceiptNumber = callbackItems.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
          const amount = callbackItems.find(item => item.Name === 'Amount')?.Value;
          const phoneNumber = callbackItems.find(item => item.Name === 'PhoneNumber')?.Value;
          
          if (mpesaReceiptNumber && amount && phoneNumber) {
            transaction = new Transaction({
              checkoutRequestID,
              merchantRequestID: stkCallback.MerchantRequestID,
              phoneNumber: phoneNumber.toString(),
              amount,
              reference: 'Recovery-' + Date.now(),
              status: 'completed',
              mpesaReceiptNumber,
              description: 'Recovered payment'
            });
            await transaction.save();
            console.log('Created recovery transaction for:', mpesaReceiptNumber);
          } else {
            return res.status(404).json({ error: 'Transaction not found and recovery not possible' });
          }
        } else {
          return res.status(200).json({ success: true });
        }
      }
    }
    
    // Update transaction based on callback result
    if (stkCallback.ResultCode === 0 && stkCallback.CallbackMetadata) {
      const callbackItems = stkCallback.CallbackMetadata.Item;
      const mpesaReceiptNumber = callbackItems.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
      const transactionDate = callbackItems.find(item => item.Name === 'TransactionDate')?.Value;
      transaction.status = 'completed';
      if (mpesaReceiptNumber) {
        transaction.mpesaReceiptNumber = mpesaReceiptNumber;
      }
      if (transactionDate) {
        const year = transactionDate.toString().substring(0, 4);
        const month = transactionDate.toString().substring(4, 6);
        const day = transactionDate.toString().substring(6, 8);
        const hour = transactionDate.toString().substring(8, 10);
        const minute = transactionDate.toString().substring(10, 12);
        const second = transactionDate.toString().substring(12, 14);
        transaction.transactionDate = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
      }
    } else {
      transaction.status = 'failed';
      transaction.responseCode = stkCallback.ResultCode;
      transaction.responseDescription = stkCallback.ResultDesc;
    }
    
    await transaction.save();
    
    return res.status(200).json({ success: true });
    
  } catch (error) {
    console.error('Error handling M-PESA callback:', error);
    return res.status(200).json({ success: true });
  }
};

// Get all transactions
exports.getTransactions = async (req, res) => {
  try {
    const transactions = await Transaction.find().sort({ createdAt: -1 });
    return res.status(200).json({
      success: true,
      count: transactions.length,
      data: transactions
    });
  } catch (error) {
    console.error('Error fetching transactions:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch transactions',
      error: error.message
    });
  }
};

// Get transaction by ID
exports.getTransactionById = async (req, res) => {
  try {
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }
    return res.status(200).json({
      success: true,
      data: transaction
    });
  } catch (error) {
    console.error('Error fetching transaction:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch transaction',
      error: error.message
    });
  }
};
