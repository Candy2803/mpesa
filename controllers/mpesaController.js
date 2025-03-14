const Transaction = require('../models/Transaction');
const mpesaHelpers = require('../utils/mpesaHelpers');
const mpesaConfig = require('../config/mpesa');
const axios = require('axios');

// Initiate STK Push
exports.initiateSTKPush = async (req, res) => {
  try {
    const { phoneNumber, amount, reference, description, userId } = req.body;
    
    // Validate required fields
    if (!phoneNumber || !amount) {
      return res.status(400).json({ error: 'Phone number and amount are required' });
    }
    
    // Format phone number (e.g. remove leading 0 or +254)
    let formattedPhone = phoneNumber;
    if (phoneNumber.startsWith('0')) {
      formattedPhone = '254' + phoneNumber.substring(1);
    } else if (phoneNumber.startsWith('+254')) {
      formattedPhone = phoneNumber.substring(1);
    }
    
    // Get MPESA access token, generate timestamp and password
    const token = await mpesaHelpers.getAccessToken();
    const timestamp = mpesaHelpers.generateTimestamp();
    const password = mpesaHelpers.generatePassword(timestamp);
    
    // Prepare STK push request body
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
    
    // Send STK push request
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
    
    // Create a new transaction record (store the userId for reference)
    const transaction = new Transaction({
      userId,  // Save the logged in user's id
      phoneNumber: formattedPhone,
      amount,
      reference,
      description: description || 'Payment',
      merchantRequestID: response.data.MerchantRequestID,
      checkoutRequestID: response.data.CheckoutRequestID,
      responseCode: response.data.ResponseCode,
      responseDescription: response.data.ResponseDescription,
      customerMessage: response.data.CustomerMessage,
      // Initially, status may be pending; we'll update it in the callback
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
    
    // Handle duplicate transaction error (if applicable)
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
    
    // Log callback data for debugging
    console.log('M-PESA Callback Data:', JSON.stringify(callbackData, null, 2));
    
    // Validate callback data structure
    if (!callbackData.Body || !callbackData.Body.stkCallback) {
      return res.status(400).json({ error: 'Invalid callback data' });
    }
    
    const stkCallback = callbackData.Body.stkCallback;
    const checkoutRequestID = stkCallback.CheckoutRequestID;
    
    // Find the transaction by checkoutRequestID
    let transaction = await Transaction.findOne({ checkoutRequestID });
    
    if (!transaction) {
      console.log('Transaction not found initially for CheckoutRequestID:', checkoutRequestID);
      
      // Try to find by merchantRequestID as a fallback
      transaction = await Transaction.findOne({ merchantRequestID: stkCallback.MerchantRequestID });
      
      if (!transaction) {
        console.error('Transaction not found for CheckoutRequestID:', checkoutRequestID);
        // If the payment was successful and callback metadata exists, create a recovery record
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
          // Even if not found, acknowledge callback so MPESA does not resend
          return res.status(200).json({ success: true });
        }
      }
    }
    
    // Only update the transaction if the user completed entering their MPESA pin
    if (stkCallback.ResultCode === 0 && stkCallback.CallbackMetadata) {
      const callbackItems = stkCallback.CallbackMetadata.Item;
      const mpesaReceiptNumber = callbackItems.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
      const transactionDate = callbackItems.find(item => item.Name === 'TransactionDate')?.Value;
      
      // Update transaction record as completed
      transaction.status = 'completed';
      if (mpesaReceiptNumber) {
        transaction.mpesaReceiptNumber = mpesaReceiptNumber;
      }
      
      if (transactionDate) {
        // Convert YYYYMMDDHHMMSS to a proper date
        const year = transactionDate.toString().substring(0, 4);
        const month = transactionDate.toString().substring(4, 6);
        const day = transactionDate.toString().substring(6, 8);
        const hour = transactionDate.toString().substring(8, 10);
        const minute = transactionDate.toString().substring(10, 12);
        const second = transactionDate.toString().substring(12, 14);
        transaction.transactionDate = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
      }
    } else {
      // If the user did not enter the pin (transaction cancelled or failed),
      // update status to 'failed' and do NOT update contribution history.
      transaction.status = 'failed';
      transaction.responseCode = stkCallback.ResultCode;
      transaction.responseDescription = stkCallback.ResultDesc;
    }
    
    // Save the updated transaction record
    await transaction.save();
    
    // Always acknowledge callback to M-PESA to prevent retries
    return res.status(200).json({ success: true });
    
  } catch (error) {
    console.error('Error handling M-PESA callback:', error);
    // Always acknowledge callback even if there was an error
    return res.status(200).json({ success: true });
  }
};

// Get all transactions for a specific user
exports.getTransactions = async (req, res) => {
  try {
    // Expect the userId in the URL parameters
    const userId = req.params.userId;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }
    
    const transactions = await Transaction.find({ userId }).sort({ createdAt: -1 });
    
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
