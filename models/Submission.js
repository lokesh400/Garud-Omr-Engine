const mongoose = require('mongoose');

const submissionSchema = new mongoose.Schema({
  // Storing as String matches your current rollnumber format
  rollnumber: {
    type: String,
    required: true,
    default: 'UNKNOWN'
  },
  // Explicitly referencing the Paper collection instead of using Mixed
  paper_id: {
    type: String, 
    required: true,
    ref: 'Paper'
  },
  submitted_at: {
    type: Date,
    default: Date.now
  },
  // Explicitly typed as Strings instead of Mixed to reduce BSON overhead
  responses: {
    type: [String],
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
  // Cloudinary account name
  cloudinary_account: {
    type: String
  },

  // Highly optimized numbers (BSON Int32/Double takes minimal space)
  score: { type: Number, default: 0 },
  totalQuestions: { type: Number, default: 0 },
  percentage: { type: Number, default: 0 },
  maxMarks: { type: Number, default: 0 },
  correctCount: { type: Number, default: 0 },
  wrongCount: { type: Number, default: 0 },
  blankCount: { type: Number, default: 0 },
  examType: { type: String, default: 'standard' },
  numericalScores: { type: mongoose.Schema.Types.Mixed, default: {} },
  mcqSubjectScores: { type: mongoose.Schema.Types.Mixed, default: {} }
}, {
  collection: 'submissions',
  timestamps: { createdAt: 'submitted_at', updatedAt: false },
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Single Compound Index: Speeds up student & paper lookups while saving storage
submissionSchema.index({ rollnumber: 1, paper_id: 1 });

// Virtual aliases for your existing backend logic compatibility
submissionSchema.virtual('rollNumber').get(function() { return this.rollnumber; }).set(function(val) { this.rollnumber = val; });
submissionSchema.virtual('paperId').get(function() { return this.paper_id; }).set(function(val) { this.paper_id = val; });
submissionSchema.virtual('omrImageUrl').get(function() { return this.cloudinary_image_url; }).set(function(val) { this.cloudinary_image_url = val; });
submissionSchema.virtual('cloudinaryPublicId').get(function() { return this.cloudinary_public_id; }).set(function(val) { this.cloudinary_public_id = val; });
submissionSchema.virtual('cloudinaryAccount').get(function() { return this.cloudinary_account; }).set(function(val) { this.cloudinary_account = val; });
submissionSchema.virtual('scannedAt').get(function() { return this.submitted_at; }).set(function(val) { this.submitted_at = val; });
submissionSchema.virtual('aggregateMarks').get(function() {
  if (this.examType === 'jee') {
    return this.score !== undefined ? this.score : 0;
  }
  const marks = (this.correctCount * 4) - (this.wrongCount * 1);
  return marks > 0 ? marks : 0;
});

module.exports = mongoose.model('Submission', submissionSchema);
