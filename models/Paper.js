const mongoose = require('mongoose');

const paperSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  numQuestions: {
    type: Number,
    required: true,
    min: 1,
    max: 200
  },
  answerKey: {
    type: Map,
    of: String // e.g., "1": "A", "2": "C", etc.
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Paper', paperSchema);
