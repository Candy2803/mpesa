const Transaction = require('../models/Transaction');
const mpesaHelpers = require('../utils/mpesaHelpers');
const mpesaConfig = require('../config/mpesa');
const axios = require('axios');

// Initiate STK Push
exports.initiateSTKPush = async (req, res) => {
  try {
    const { phoneNumber, amount, reference, description } = req.body;
    
    // Validate request
    if (!phoneNumber || !amount) {
      return res.status(400).json({ error: 'Phone number, amount are required' });
    }
    
    // Format phone number (remove leading 0 or +254)
    let formattedPhone = phoneNumber;
    if (phoneNumber.startsWith('0')) {
      formattedPhone = '254' + phoneNumber.substring(1);
    } else if (phoneNumber.startsWith('+254')) {
      formattedPhone = phoneNumber.substring(1);
    }
    
    // Get access token
    const token = await mpesaHelpers.getAccessToken();
    
    // Generate timestamp
    const timestamp = mpesaHelpers.generateTimestamp();
    
    // Generate password
    const password = mpesaHelpers.generatePassword(timestamp);
    
    // Prepare STK Push request
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
    
    // Make STK Push request
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
    
    // Save transaction to database
    const transaction = new Transaction({
      phoneNumber: formattedPhone,
      amount,
      reference,
      description: description || 'Payment',
      merchantRequestID: response.data.MerchantRequestID,
      checkoutRequestID: response.data.CheckoutRequestID,
      responseCode: response.data.ResponseCode,
      responseDescription: response.data.ResponseDescription,
      customerMessage: response.data.CustomerMessage,
      // Don't set mpesaReceiptNumber at this stage, it will be added in the callback
    });
    
    await transaction.save();
    
    // Return response
    return res.status(200).json({
      success: true,
      message: 'STK Push initiated successfully',
      data: response.data,
      transactionId: transaction._id
    });
    
  } catch (error) {
    console.error('Error initiating STK Push:', error);
    
    // Check if it's a duplicate key error specifically for an already initiated transaction
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
      
      // Try to find by merchantRequestID
      transaction = await Transaction.findOne({ merchantRequestID: stkCallback.MerchantRequestID });
      
      if (!transaction) {
        console.error('Transaction not found for CheckoutRequestID:', checkoutRequestID);
        
        // Fallback: If payment successful, create a new transaction record as a recovery
        if (stkCallback.ResultCode === 0 && stkCallback.CallbackMetadata) {
          const callbackItems = stkCallback.CallbackMetadata.Item;
          const mpesaReceiptNumber = callbackItems.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
          const amount = callbackItems.find(item => item.Name === 'Amount')?.Value;
          const phoneNumber = callbackItems.find(item => item.Name === 'PhoneNumber')?.Value;
          
          if (mpesaReceiptNumber && amount && phoneNumber) {
            // IMPORTANT: Ensure you also store the associated userId when creating the transaction record.
            transaction = new Transaction({
              userId: callbackData.userId, // You may need to pass this via the callback or retrieve it somehow.
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
          // Acknowledge receipt even if no matching transaction is found.
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
      // Payment failed
      transaction.status = 'failed';
      transaction.responseCode = stkCallback.ResultCode;
      transaction.responseDescription = stkCallback.ResultDesc;
    }
    
    // Save updated transaction
    await transaction.save();

    // If the transaction is completed, post the transaction details to the contributions endpoint.
    if (transaction.status === 'completed' && transaction.userId) {
      try {
        await axios.post(
          `https://mwg-app-api.vercel.app/api/contributions/${transaction.userId}/contributions`,
          {
            phoneNumber: transaction.phoneNumber,
            amount: transaction.amount,
            merchantRequestID: transaction.merchantRequestID,
            checkoutRequestID: transaction.checkoutRequestID,
            mpesaReceiptNumber: transaction.mpesaReceiptNumber,
            transactionDate: transaction.transactionDate,
            status: transaction.status,
          },
          {
            headers: {
              "Content-Type": "application/json",
            },
          }
        );
        console.log("Transaction details sent to contributions endpoint.");
      } catch (postError) {
        console.error("Error posting transaction to contributions endpoint:", postError.response ? postError.response.data : postError.message);
      }
    }
    
    // Respond to M-PESA (required)
    return res.status(200).json({ success: true });
    
  } catch (error) {
    console.error('Error handling M-PESA callback:', error);
    // Always acknowledge the callback to M-PESA, even on errors
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