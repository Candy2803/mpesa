const Transaction = require('../models/Transaction');
const mpesaHelpers = require('../utils/mpesaHelpers');
const mpesaConfig = require('../config/mpesa');
const axios = require('axios');

// Initiate STK Push
exports.initiateSTKPush = async (req, res) => {
  try {
    const { phoneNumber, amount, reference, description, userId } = req.body;
    
    if (!phoneNumber || !amount) {
      return res.status(400).json({ error: 'Phone number and amount are required' });
    }
    
    // Format phone number (e.g., convert 0712345678 to 254712345678)
    let formattedPhone = phoneNumber;
    if (phoneNumber.startsWith('0')) {
      formattedPhone = '254' + phoneNumber.substring(1);
    } else if (phoneNumber.startsWith('+254')) {
      formattedPhone = phoneNumber.substring(1);
    }
    
    // Get MPESA access token, timestamp, and password
    const token = await mpesaHelpers.getAccessToken();
    const timestamp = mpesaHelpers.generateTimestamp();
    const password = mpesaHelpers.generatePassword(timestamp);
    
    // Prepare STK push request payload
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
    
    // Initiate the STK push
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
    
    // Create a new transaction record with initial status "pending"
    const transaction = new Transaction({
      userId,  // Link transaction to the logged-in user
      phoneNumber: formattedPhone,
      amount,
      reference,
      description: description || 'Payment',
      merchantRequestID: response.data.MerchantRequestID,
      checkoutRequestID: response.data.CheckoutRequestID,
      responseCode: response.data.ResponseCode,
      responseDescription: response.data.ResponseDescription,
      customerMessage: response.data.CustomerMessage,
      status: "pending"
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

// Handle callback from MPESA
exports.handleCallback = async (req, res) => {
  try {
    // MPESA sends callback data in the request body
    const callbackData = req.body;
    
    console.log('M-PESA Callback Data:', JSON.stringify(callbackData, null, 2));
    
    // Validate that the callback has the expected structure
    if (!callbackData.Body || !callbackData.Body.stkCallback) {
      return res.status(400).json({ error: 'Invalid callback data' });
    }
    
    const stkCallback = callbackData.Body.stkCallback;
    const checkoutRequestID = stkCallback.CheckoutRequestID;
    
    // Find the corresponding transaction using checkoutRequestID
    let transaction = await Transaction.findOne({ checkoutRequestID });
    
    if (!transaction) {
      console.log('Transaction not found for CheckoutRequestID:', checkoutRequestID);
      
      // Attempt to recover by merchantRequestID
      transaction = await Transaction.findOne({ merchantRequestID: stkCallback.MerchantRequestID });
      
      if (!transaction) {
        console.error('Transaction not found for CheckoutRequestID:', checkoutRequestID);
        // If it's a successful payment, attempt to recover; otherwise, acknowledge callback
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
    
    // Update the transaction record only if the payment was successful
    if (stkCallback.ResultCode === 0 && stkCallback.CallbackMetadata) {
      const callbackItems = stkCallback.CallbackMetadata.Item;
      const mpesaReceiptNumber = callbackItems.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
      const transactionDate = callbackItems.find(item => item.Name === 'TransactionDate')?.Value;
      
      // Only update the transaction if the user entered their MPESA PIN (i.e., ResultCode is "0")
      transaction.status = 'completed';
      if (mpesaReceiptNumber) {
        transaction.mpesaReceiptNumber = mpesaReceiptNumber;
      }
      
      if (transactionDate) {
        // Convert transaction date from YYYYMMDDHHMMSS format to a proper JavaScript Date
        const year = transactionDate.toString().substring(0, 4);
        const month = transactionDate.toString().substring(4, 6);
        const day = transactionDate.toString().substring(6, 8);
        const hour = transactionDate.toString().substring(8, 10);
        const minute = transactionDate.toString().substring(10, 12);
        const second = transactionDate.toString().substring(12, 14);
        transaction.transactionDate = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
      }
    } else {
      // If the transaction was cancelled or failed (user did not enter their MPESA PIN), do not update the contribution history.
      transaction.status = 'failed';
      transaction.responseCode = stkCallback.ResultCode;
      transaction.responseDescription = stkCallback.ResultDesc;
    }
    
    await transaction.save();
    
    // Always acknowledge the callback to MPESA
    return res.status(200).json({ success: true });
    
  } catch (error) {
    console.error('Error handling M-PESA callback:', error);
    return res.status(200).json({ success: true });
  }
};

// Get all transactions for a specific user
exports.getTransactions = async (req, res) => {
  try {
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
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }
    return res.status(200).json({ success: true, data: transaction });
  } catch (error) {
    console.error('Error fetching transaction:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch transaction', error: error.message });
  }
};
