const mongoose = require('mongoose');

const submissionSchema = new mongoose.Schema({
  rollnumber: {
    type: String,
    required: true,
    default: 'UNKNOWN',
    index: true
  },
  paper_id: {
    type: mongoose.Schema.Types.Mixed,
    ref: 'Paper',
    required: true,
    index: true
  },
  submitted_at: {
    type: Date,
    default: Date.now,
    index: true
  },
  // Array of answers: "A", "B", "C", "D", or null for blank/unmarked
  responses: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  },
  // Cloudinary image link for viewing checked copy
  cloudinary_image_url: {
    type: String,
    required: true
  },
  // Cloudinary public ID for deleting later
  cloudinary_public_id: {
    type: String,
    required: true
  },
  // Cloudinary account name (which of the 5 accounts it was uploaded to)
  cloudinary_account: {
    type: String
  },

  // Computed Evaluation Metrics for fast querying and display
  score: {
    type: Number,
    default: 0
  },
  totalQuestions: {
    type: Number,
    default: 0
  },
  percentage: {
    type: Number,
    default: 0
  },
  aggregateMarks: {
    type: Number,
    default: 0
  },
  maxMarks: {
    type: Number,
    default: 0
  },
  correctCount: {
    type: Number,
    default: 0
  },
  wrongCount: {
    type: Number,
    default: 0
  },
  multipleCount: {
    type: Number,
    default: 0
  },
  blankCount: {
    type: Number,
    default: 0
  },
  sectionWise: [{
    sectionName: String,
    range: String,
    marks: Number,
    maxMarks: Number,
    correct: Number,
    wrong: Number,
    multiple: Number,
    blank: Number
  }],
  breakdown: [{
    q: Number,
    marked: String,
    correctKey: String,
    verdict: String
  }]
}, {
  collection: 'submissions',
  timestamps: { createdAt: 'submitted_at', updatedAt: false },
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtual aliases for seamless property access
submissionSchema.virtual('rollNumber')
  .get(function() { return this.rollnumber; })
  .set(function(val) { this.rollnumber = val; });

submissionSchema.virtual('paperId')
  .get(function() { return this.paper_id; })
  .set(function(val) { this.paper_id = val; });

submissionSchema.virtual('omrImageUrl')
  .get(function() { return this.cloudinary_image_url; })
  .set(function(val) { this.cloudinary_image_url = val; });

submissionSchema.virtual('cloudinaryPublicId')
  .get(function() { return this.cloudinary_public_id; })
  .set(function(val) { this.cloudinary_public_id = val; });

submissionSchema.virtual('cloudinaryAccount')
  .get(function() { return this.cloudinary_account; })
  .set(function(val) { this.cloudinary_account = val; });

submissionSchema.virtual('scannedAt')
  .get(function() { return this.submitted_at; })
  .set(function(val) { this.submitted_at = val; });

module.exports = mongoose.model('Submission', submissionSchema);
