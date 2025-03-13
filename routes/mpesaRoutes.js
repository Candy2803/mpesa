const express = require('express');
const router = express.Router();
const mpesaController = require('../controllers/mpesaController');

// Initiate STK Push
router.post('/stkpush', mpesaController.initiateSTKPush);

// Handle callback from M-PESA
router.post('/callback', mpesaController.handleCallback);

// Get transactions for a specific user
router.get('/transactions/:userId', mpesaController.getTransactions);

// Get transaction by ID
router.get('/transaction/:id', mpesaController.getTransactionById);

module.exports = router;
