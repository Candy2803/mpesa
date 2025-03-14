const Transaction = require('../models/Transaction');
const mpesaHelpers = require('../utils/mpesaHelpers');
const mpesaConfig = require('../config/mpesa');
const axios = require('axios');

// Initiate STK Push
// controllers/mpesaController.js

exports.initiateSTKPush = async (req, res) => {
  try {
    const { phoneNumber, amount, reference, description, userId } = req.body;
    
    
    if (!phoneNumber || !amount) {
      return res.status(400).json({ error: 'Phone number, amount are required' });
    }
    
    // Format phone number
    let formattedPhone = phoneNumber;
    if (phoneNumber.startsWith('0')) {
      formattedPhone = '254' + phoneNumber.substring(1);
    } else if (phoneNumber.startsWith('+254')) {
      formattedPhone = phoneNumber.substring(1);
    }
    
    const token = await mpesaHelpers.getAccessToken();
    const timestamp = mpesaHelpers.generateTimestamp();
    const password = mpesaHelpers.generatePassword(timestamp);
    
    const stkPushRequestBody = {
      BusinessShortCode: mpesaConfig.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: formattedPhone,
      PartyB: mpesaConfig.shortcode,
      PhoneNumber: formattedPhone,
      CallBackURL: mpesaConfig.callbackUrl,
      AccountReference: reference || 'Payment',
      TransactionDesc: description || 'Payment'
    };
    
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
    
    // Create a new transaction record including the userId
    const transaction = new Transaction({
      userId,  // save the logged in user's id
      phoneNumber: formattedPhone,
      amount,
      reference,
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
    // M-PESA sends callback data in the request body
    const callbackData = req.body;
    
    // Log the callback data for debugging
    console.log('M-PESA Callback Data:', JSON.stringify(callbackData, null, 2));
    
    // Check if we have a valid callback
    if (!callbackData.Body || !callbackData.Body.stkCallback) {
      return res.status(400).json({ error: 'Invalid callback data' });
    }
    
    const stkCallback = callbackData.Body.stkCallback;
    const checkoutRequestID = stkCallback.CheckoutRequestID;
    
    // Find the transaction by checkoutRequestID
    let transaction = await Transaction.findOne({ checkoutRequestID });
    
    if (!transaction) {
      console.log('Transaction not found initially for CheckoutRequestID:', checkoutRequestID);
      
      // If transaction not found by checkoutRequestID, try to find by merchantRequestID
      transaction = await Transaction.findOne({ merchantRequestID: stkCallback.MerchantRequestID });
      
      if (!transaction) {
        console.error('Transaction not found for CheckoutRequestID:', checkoutRequestID);
        
        // If this is a successful payment, create a new transaction record as a fallback
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
          // Just acknowledge receipt to M-PESA even if we can't find the transaction
          return res.status(200).json({ success: true });
        }
      }
    }
    
    // Update transaction based on callback result
    if (stkCallback.ResultCode === 0 && stkCallback.CallbackMetadata) {
      // Payment successful
      const callbackItems = stkCallback.CallbackMetadata.Item;
      const mpesaReceiptNumber = callbackItems.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
      const transactionDate = callbackItems.find(item => item.Name === 'TransactionDate')?.Value;
      
      // Update transaction record
      transaction.status = 'completed';
      if (mpesaReceiptNumber) {
        transaction.mpesaReceiptNumber = mpesaReceiptNumber;
      }
      
      if (transactionDate) {
        // Convert the format from YYYYMMDDHHMMSS to a proper date
        const year = transactionDate.toString().substring(0, 4);
        const month = transactionDate.toString().substring(4, 6);
        const day = transactionDate.toString().substring(6, 8);
        const hour = transactionDate.toString().substring(8, 10);
        const minute = transactionDate.toString().substring(10, 12);
        const second = transactionDate.toString().substring(12, 14);
        
        transaction.transactionDate = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
      }
    } else {
      // Payment failed
      transaction.status = 'failed';
      transaction.responseCode = stkCallback.ResultCode;
      transaction.responseDescription = stkCallback.ResultDesc;
    }
    
    // Save updated transaction
    await transaction.save();
    
    // Respond to M-PESA (required)
    return res.status(200).json({ success: true });
    
  } catch (error) {
    console.error('Error handling M-PESA callback:', error);
    // Always acknowledge the callback to M-PESA, even on errors
    return res.status(200).json({ success: true });
  }
};

// Get all transactions
// Get all transactions for a specific user (only "completed" transactions)
exports.getTransactions = async (req, res) => {
  console.log("Fetching transactions for user:", req.params.userId);
  try {
    // Expect the userId in the URL parameters
    const userId = req.params.userId;
    if (!userId) {
      return res.status(400).json({ success: false, message: "User ID is required" });
    }
    
    // Only return transactions with a status of "completed"
    const transactions = await Transaction.find({ 
      userId, 
      status: "completed" 
    }).sort({ createdAt: -1 });
    
    return res.status(200).json({
      success: true,
      count: transactions.length,
      data: transactions,
    });
  } catch (error) {
    console.error("Error fetching transactions:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch transactions",
      error: error.message,
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