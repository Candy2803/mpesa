const express = require('express');
const router = express.Router();
const mpesaController = require('../controllers/mpesaController');

// Initiate STK Push
router.post('/stkpush', mpesaController.initiateSTKPush);

// Handle callback from M-PESA
router.post('/callback', mpesaController.handleCallback);

// Get all transactions
router.get('/transactions', mpesaController.getTransactions);

// Get transaction by ID
router.get('/transactions/:id', mpesaController.getTransactionById);

module.exports = router;