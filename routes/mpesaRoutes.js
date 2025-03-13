const express = require('express');
const router = express.Router();
const mpesaController = require('../controllers/mpesaController');

// Initiate STK Push
router.post('/stkpush', mpesaController.initiateSTKPush);

// Handle M-PESA Callback
router.post('/callback', mpesaController.handleCallback);

// Get all transactions
router.get('/transactions', mpesaController.getTransactions);

// Get a transaction by ID
router.get('/transactions/:id', mpesaController.getTransactionById);

module.exports = router;
