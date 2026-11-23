const LocalStrategy = require('passport-local').Strategy;
const User = require('../models/User');

function configurePassport(passport) {
    passport.use(new LocalStrategy(User.authenticate()));
    passport.serializeUser(User.serializeUser());
    passport.deserializeUser(User.deserializeUser());
}

module.exports = configurePassport;
