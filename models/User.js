const mongoose = require('mongoose');
const plm = require('passport-local-mongoose');
const passportLocalMongoose = plm.default || plm;

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  fullName: {
    type: String,
    trim: true,
    default: ''
  },
  role: {
    type: String,
    enum: ['admin', 'student'],
    required: true,
    default: 'student'
  },
  rollnumber: {
    type: String,
    trim: true,
    default: ''
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  collection: 'users',
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

userSchema.index({ rollnumber: 1, role: 1 });

userSchema.virtual('isAdmin').get(function () {
  return this.role === 'admin';
});

userSchema.plugin(passportLocalMongoose, {
  usernameField: 'username',
  usernameLowerCase: true,
  usernameUnique: true,
  errorMessages: {
    MissingUsernameError: 'Username is required.',
    MissingPasswordError: 'Password is required.',
    UserExistsError: 'An account with that username already exists.',
    IncorrectUsernameError: 'Invalid username or password.',
    IncorrectPasswordError: 'Invalid username or password.'
  }
});

module.exports = mongoose.model('User', userSchema);

