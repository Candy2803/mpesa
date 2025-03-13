const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
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
    sparse: true  // This makes the index only apply to documents that have the field
  },
  transactionDate: Date,
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed'],
    default: 'pending'
  }
}, { timestamps: true });

// Add a compound index to ensure uniqueness of checkoutRequestID
transactionSchema.index({ checkoutRequestID: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Transaction', transactionSchema);