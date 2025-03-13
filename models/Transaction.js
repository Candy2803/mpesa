// models/Transaction.js
const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',  // if you have a User model
    required: true,
  },
  phoneNumber: {
    type: String,
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  reference: {
    type: String,
    required: true,
    default: 'Payment'
  },
  description: {
    type: String,
    default: 'Payment'
  },
  merchantRequestID: String,
  checkoutRequestID: String,
  responseCode: String,
  responseDescription: String,
  customerMessage: String,
  mpesaReceiptNumber: {
    type: String,
    unique: true,
    sparse: true
  },
  transactionDate: Date,
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed'],
    default: 'pending'
  }
}, { timestamps: true });

transactionSchema.index({ checkoutRequestID: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Transaction', transactionSchema);
