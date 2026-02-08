const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema({
    // Connects the transaction to a specific user
    userId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true 
    },
    // The type of movement: Deposit, Withdrawal, or Ride Payment
    type: { 
        type: String, 
        enum: ['Deposit', 'Withdrawal', 'Payment'], 
        required: true 
    },
    amount: { 
        type: Number, 
        required: true 
    },
    // Useful for tracking M-Pesa status
    status: { 
        type: String, 
        enum: ['Pending', 'Completed', 'Failed'], 
        default: 'Pending' 
    },
    // Stores the M-Pesa Receipt Number (e.g., RLE73S8D9)
    mpesaReceipt: { 
        type: String, 
        unique: true, 
        sparse: true 
    },
    description: { 
        type: String, 
        default: 'RideWithMeru Transaction' 
    },
    createdAt: { 
        type: Date, 
        default: Date.now 
    }
});

module.exports = mongoose.model('Transaction', TransactionSchema);