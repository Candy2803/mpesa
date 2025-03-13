const Transaction = require('../models/Transaction');
const mpesaHelpers = require('../utils/mpesaHelpers');
const mpesaConfig = require('../config/mpesa');
const axios = require('axios');

// Initiate STK Push
// Initiate STK Push
exports.initiateSTKPush = async (req, res) => {
  try {
    const { phoneNumber, amount, reference, description } = req.body;
    
    // Validate request
    if (!phoneNumber || !amount) {
      return res.status(400).json({ error: 'Phone number and amount are required' });
    }
    
    // Format phone number (remove leading 0 or +254)
    // Format phone number to 2547XXXXXXXX
let formattedPhone = phoneNumber.trim();

// If the number starts with '0', replace it with '254'
if (formattedPhone.startsWith('0')) {
  formattedPhone = '254' + formattedPhone.substring(1);
} else if (formattedPhone.startsWith('+254')) {
  // Remove the '+' sign if it starts with '+254'
  formattedPhone = formattedPhone.substring(1);
} else if (!formattedPhone.startsWith('254')) {
  // Optionally, throw an error or prompt the user if the number is in an unexpected format.
  return res.status(400).json({ error: 'Invalid phone number format' });
}

// Optionally, check if the formatted number has the correct length (12 digits: 254 followed by 9 digits)
if (formattedPhone.length !== 12) {
  return res.status(400).json({ error: 'Phone number must be 12 digits in the format 2547XXXXXXXX' });
}

    
    // Get access token
    const token = await mpesaHelpers.getAccessToken();
    
    // Generate timestamp
    const timestamp = mpesaHelpers.generateTimestamp();
    
    // Generate password using your passkey, shortcode, and timestamp
    const password = mpesaHelpers.generatePassword(timestamp);
    
    // Prepare STK Push request with fixed paybill and account number
    const stkPushRequestBody = {
      BusinessShortCode: "500005",            // Fixed paybill number
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: formattedPhone,
      PartyB: "500005",                        // Same as BusinessShortCode
      PhoneNumber: formattedPhone,
      CallBackURL: mpesaConfig.callbackUrl,
      AccountReference: "BA0619032",           // Fixed account number
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
      reference: reference || 'Payment',
      description: description || 'Payment',
      merchantRequestID: response.data.MerchantRequestID,
      checkoutRequestID: response.data.CheckoutRequestID,
      responseCode: response.data.ResponseCode,
      responseDescription: response.data.ResponseDescription,
      customerMessage: response.data.CustomerMessage,
      // mpesaReceiptNumber will be added in the callback
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
    
    // Handle duplicate transaction error for checkoutRequestID
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