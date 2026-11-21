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
    enum: ['admin', 'teacher', 'student'],
    required: true,
    default: 'student'
  },
  rollnumber: {
    type: String,
    trim: true,
    default: ''
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
    default: ''
  },
  resetPasswordOtp: {
    type: String,
    default: null
  },
  resetPasswordOtpExpires: {
    type: Date,
    default: null
  },
  resetPasswordOtpAttempts: {
    type: Number,
    default: 0
  },
  resetPasswordLastRequestedAt: {
    type: Date,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  collection: 'users',
  toJSON: {
    virtuals: true,
    transform: function (doc, ret) {
      delete ret.hash;
      delete ret.salt;
      delete ret.resetPasswordOtp;
      delete ret.resetPasswordOtpExpires;
      delete ret.resetPasswordOtpAttempts;
      delete ret.resetPasswordLastRequestedAt;
      delete ret.__v;
      return ret;
    }
  },
  toObject: {
    virtuals: true,
    transform: function (doc, ret) {
      delete ret.hash;
      delete ret.salt;
      delete ret.resetPasswordOtp;
      delete ret.resetPasswordOtpExpires;
      delete ret.resetPasswordOtpAttempts;
      delete ret.resetPasswordLastRequestedAt;
      delete ret.__v;
      return ret;
    }
  }
});

userSchema.index({ rollnumber: 1, role: 1 });

userSchema.virtual('isAdmin').get(function () {
  return this.role === 'admin';
});

userSchema.virtual('isTeacher').get(function () {
  return this.role === 'teacher';
});

userSchema.virtual('isStudent').get(function () {
  return this.role === 'student';
});

userSchema.virtual('canManage').get(function () {
  return this.role === 'admin';
});

userSchema.virtual('canViewStaff').get(function () {
  return this.role === 'admin' || this.role === 'teacher';
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

