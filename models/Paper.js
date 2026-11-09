const mongoose = require('mongoose');

const sectionSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  from_question: {
    type: Number,
    required: true,
    min: 1
  },
  to_question: {
    type: Number,
    required: true,
    min: 1
  },
  max_marks: {
    type: Number,
    default: function() {
      if (this.from_question && this.to_question) {
        return (this.to_question - this.from_question + 1) * 4;
      }
      return 0;
    }
  }
}, { _id: false });

const paperSchema = new mongoose.Schema({
  _id: {
    type: mongoose.Schema.Types.Mixed,
    default: () => new mongoose.Types.ObjectId().toString()
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  subject: {
    type: String,
    default: 'General',
    trim: true
  },
  total_questions: {
    type: Number,
    required: true,
    min: 1,
    max: 200
  },
  max_marks: {
    type: Number,
    default: function() {
      return (this.total_questions || 50) * 4;
    }
  },
  // The official answer key to grade against: Array of items ["A", "C", "C", "D", ...]
  answer_key: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  },
  // Multiple sections in the paper with selectable question ranges
  sections: {
    type: [sectionSchema],
    default: []
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  collection: 'papers',
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Backward-compatibility Virtuals
paperSchema.virtual('numQuestions')
  .get(function() {
    return this.total_questions;
  })
  .set(function(val) {
    this.total_questions = Number(val);
  });

paperSchema.virtual('answerKey')
  .get(function() {
    const map = new Map();
    if (Array.isArray(this.answer_key)) {
      this.answer_key.forEach((ans, idx) => {
        if (ans) map.set(String(idx + 1), ans);
      });
    }
    return map;
  })
  .set(function(val) {
    if (Array.isArray(val)) {
      this.answer_key = val;
    } else if (val && typeof val === 'object') {
      const total = this.total_questions || 50;
      const arr = new Array(total).fill(null);
      for (let i = 1; i <= total; i++) {
        const v = (val instanceof Map) ? val.get(String(i)) : val[String(i)];
        arr[i - 1] = v ? String(v).toUpperCase() : null;
      }
      this.answer_key = arr;
    }
  });

// Sections string representation virtual
paperSchema.virtual('sections_string')
  .get(function() {
    return JSON.stringify(this.sections || []);
  })
  .set(function(val) {
    if (typeof val === 'string') {
      try {
        this.sections = JSON.parse(val);
      } catch (e) {
        console.warn('Could not parse sections string:', e.message);
      }
    } else if (Array.isArray(val)) {
      this.sections = val;
    }
  });

// Pre-validate hook
paperSchema.pre('validate', function(next) {
  if (typeof this.sections === 'string') {
    try {
      this.sections = JSON.parse(this.sections);
    } catch (e) {
      this.sections = [];
    }
  }
  if (!this.total_questions && this.numQuestions) {
    this.total_questions = Number(this.numQuestions);
  }
  if (!this.max_marks && this.total_questions) {
    this.max_marks = this.total_questions * 4;
  }
  next();
});

module.exports = mongoose.model('Paper', paperSchema);
