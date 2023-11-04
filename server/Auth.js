const passport = require('passport')
const bcrypt = require('./libs/bcryptjs')
const jwt = require('./libs/jsonwebtoken')
const LocalStrategy = require('./libs/passportLocal')
const JwtStrategy = require('passport-jwt').Strategy
const ExtractJwt = require('passport-jwt').ExtractJwt
const GoogleStrategy = require('passport-google-oauth20').Strategy
const OpenIDConnectStrategy = require('passport-openidconnect')
const Database = require('./Database')
const User = require('./objects/user/User')

/**
 * @class Class for handling all the authentication related functionality.
 */
class Auth {

  constructor() {
  }

  static cors(req, res, next) {
    res.header('Access-Control-Allow-Origin', '*')
    res.header("Access-Control-Allow-Methods", 'GET, POST, PATCH, PUT, DELETE, OPTIONS')
    res.header('Access-Control-Allow-Headers', '*')
    res.header('Access-Control-Allow-Credentials', true)
    if (req.method === 'OPTIONS') {
      res.sendStatus(200)
    } else {
      next()
    }
  }

  /**
   * Inializes all passportjs strategies and other passportjs ralated initialization.
   */
  async initPassportJs() {
    // Check if we should load the local strategy (username + password login)
    if (global.ServerSettings.authActiveAuthMethods.includes("local")) {
      passport.use(new LocalStrategy(this.localAuthCheckUserPw.bind(this)))
    }

    // Check if we should load the google-oauth20 strategy
    if (global.ServerSettings.authActiveAuthMethods.includes("google-oauth20")) {
      passport.use(new GoogleStrategy({
        clientID: global.ServerSettings.authGoogleOauth20ClientID,
        clientSecret: global.ServerSettings.authGoogleOauth20ClientSecret,
        callbackURL: global.ServerSettings.authGoogleOauth20CallbackURL,
        userProfileURL: "https://www.googleapis.com/oauth2/v3/userinfo",
        scope: ['given_name', 'email'] //TODO: do not get the given name
      }, (async function (accessToken, refreshToken, profile, done) {
        // get user by email
        const email = profile.emails[0].value.toLowerCase()
        const user = await Database.userModel.getUserByEmail(email)

        if (!user && global.ServerSettings.authAutoUserCreation) {
          // create the user automatically
          this.createNewUserViaEmail(email, email.replace('@', '_').replace('.', '_'))
        }
        else if (!user || !user.isActive) {
          // deny login
          done(null, null)
          return
        }

        // permit login
        return done(null, user)
      }).bind(this)))
    }

    // Check if we should load the openid strategy
    if (global.ServerSettings.authActiveAuthMethods.includes("openid")) {
      passport.use(new OpenIDConnectStrategy({
        issuer: global.ServerSettings.authOpenIDIssuerURL,
        authorizationURL: global.ServerSettings.authOpenIDAuthorizationURL,
        tokenURL: global.ServerSettings.authOpenIDTokenURL,
        userInfoURL: global.ServerSettings.authOpenIDUserInfoURL,
        clientID: global.ServerSettings.authOpenIDClientID,
        clientSecret: global.ServerSettings.authOpenIDClientSecret,
        callbackURL: '/auth/openid/callback',
        scope: ["openid", "email", "profile"],
        skipUserProfile: false
      }, async (issuer, profile, done) => {
        // TODO: do we want to create the users which does not exist?

        // get user by email
        const email = profile.emails[0].value.toLowerCase()
        var user = await Database.userModel.getUserByEmail(email)

        if (!user && global.ServerSettings.authAutoUserCreation) {
          // create the user automatically
          this.createNewUserViaEmail(email, profile.username)
        }
        else if (!user?.isActive) {
          // deny login
          done(null, null)
          return
        }

        // permit login
        return done(null, user)
      }))
    }

    // Load the JwtStrategy (always) -> for bearer token auth 
    passport.use(new JwtStrategy({
      jwtFromRequest: ExtractJwt.fromExtractors([ExtractJwt.fromAuthHeaderAsBearerToken(), ExtractJwt.fromUrlQueryParameter('token')]),
      secretOrKey: Database.serverSettings.tokenSecret
    }, this.jwtAuthCheck.bind(this)))

    // define how to seralize a user (to be put into the session)
    passport.serializeUser(function (user, cb) {
      process.nextTick(function () {
        // only store id to session
        return cb(null, JSON.stringify({
          "id": user.id,
        }))
      })
    })

    // define how to deseralize a user (use the ID to get it from the database)
    passport.deserializeUser((function (user, cb) {
      process.nextTick((async function () {
        const parsedUserInfo = JSON.parse(user)
        // load the user by ID that is stored in the session
        const dbUser = await Database.userModel.getUserById(parsedUserInfo.id)
        return cb(null, dbUser)
      }).bind(this))
    }).bind(this))
  }

  /**
   * Stores the client's choice how the login callback should happen in temp cookies
   * 
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  paramsToCookies(req, res) {
    if (req.query.isRest?.toLowerCase() == "true") {
      // store the isRest flag to the is_rest cookie 
      res.cookie('is_rest', req.query.isRest.toLowerCase(), {
        maxAge: 120000, // 2 min
        httpOnly: true
      })
    } else {
      // no isRest-flag set -> set is_rest cookie to false
      res.cookie('is_rest', "false", {
        maxAge: 120000, // 2 min
        httpOnly: true
      })

      // persist state if passed in
      if (req.query.state) {
        res.cookie('auth_state', req.query.state, {
          maxAge: 120000, // 2 min
          httpOnly: true
        })
      }

      const callback = req.query.redirect_uri || req.query.callback

      // check if we are missing a callback parameter - we need one if isRest=false
      if (!callback) {
        res.status(400).send({
          message: 'No callback parameter'
        })
        return
      }
      // store the callback url to the auth_cb cookie 
      res.cookie('auth_cb', callback, {
        maxAge: 120000, // 2 min
        httpOnly: true
      })
    }
  }

  /**
   * Informs the client in the right mode about a successfull login and the token
   * (clients choise is restored from cookies).
   * 
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  async handleLoginSuccessBasedOnCookie(req, res) {
    // get userLogin json (information about the user, server and the session)
    const data_json = await this.getUserLoginResponsePayload(req.user)

    if (req.cookies.is_rest === 'true') {
      // REST request - send data
      res.json(data_json)
    } else {
      // UI request -> check if we have a callback url
      // TODO: do we want to somehow limit the values for auth_cb?
      if (req.cookies.auth_cb) {
        let stateQuery = req.cookies.auth_state ? `&state=${req.cookies.auth_state}` : ''
        // UI request -> redirect to auth_cb url and send the jwt token as parameter
        res.redirect(302, `${req.cookies.auth_cb}?setToken=${data_json.user.token}${stateQuery}`)
      } else {
        res.status(400).send('No callback or already expired')
      }
    }
  }

  /**
   * Creates all (express) routes required for authentication.
   * 
   * @param {import('express').Router} router 
   */
  async initAuthRoutes(router) {
    // Local strategy login route (takes username and password)
    router.post('/login', passport.authenticate('local'), async (req, res) => {
      // return the user login response json if the login was successfull
      res.json(await this.getUserLoginResponsePayload(req.user))
    })

    // google-oauth20 strategy login route (this redirects to the google login)
    router.get('/auth/google', (req, res, next) => {
      const auth_func = passport.authenticate('google', { scope: ['email'] })
      // params (isRest, callback) to a cookie that will be send to the client
      this.paramsToCookies(req, res)
      auth_func(req, res, next)
    })

    // google-oauth20 strategy callback route (this receives the token from google)
    router.get('/auth/google/callback',
      passport.authenticate('google'),
      // on a successfull login: read the cookies and react like the client requested (callback or json)
      this.handleLoginSuccessBasedOnCookie.bind(this)
    )

    // openid strategy login route (this redirects to the configured openid login provider)
    router.get('/auth/openid', (req, res, next) => {
      const auth_func = passport.authenticate('openidconnect')
      // params (isRest, callback) to a cookie that will be send to the client
      this.paramsToCookies(req, res)
      auth_func(req, res, next)
    })

    // openid strategy callback route (this receives the token from the configured openid login provider)
    router.get('/auth/openid/callback',
      passport.authenticate('openidconnect'),
      // on a successfull login: read the cookies and react like the client requested (callback or json)
      this.handleLoginSuccessBasedOnCookie.bind(this))

    // Logout route
    router.post('/logout', (req, res) => {
      // TODO: invalidate possible JWTs
      req.logout((err) => {
        if (err) {
          res.sendStatus(500)
        } else {
          res.sendStatus(200)
        }
      })
    })
  }

  /**
   * middleware to use in express to only allow authenticated users.
   * @param {import('express').Request} req 
   * @param {import('express').Response} res 
   * @param {import('express').NextFunction} next  
   */
  isAuthenticated(req, res, next) {
    // check if session cookie says that we are authenticated
    if (req.isAuthenticated()) {
      next()
    } else {
      // try JWT to authenticate
      passport.authenticate("jwt")(req, res, next)
    }
  }

  /**
   * Function to generate a jwt token for a given user
   * 
   * @param {Object} user 
   * @returns {string} token
   */
  generateAccessToken(user) {
    return jwt.sign({ userId: user.id, username: user.username }, global.ServerSettings.tokenSecret)
  }

  /**
   * Function to validate a jwt token for a given user
   * 
   * @param {string} token 
   * @returns {Object} tokens data
   */
  static validateAccessToken(token) {
    try {
      return jwt.verify(token, global.ServerSettings.tokenSecret)
    }
    catch (err) {
      return null
    }
  }

  /**
   * Generate a token which is used to encrpt/protect the jwts.
   */
  async initTokenSecret() {
    if (process.env.TOKEN_SECRET) { // User can supply their own token secret
      Database.serverSettings.tokenSecret = process.env.TOKEN_SECRET
    } else {
      Database.serverSettings.tokenSecret = require('crypto').randomBytes(256).toString('base64')
    }
    await Database.updateServerSettings()

    // New token secret creation added in v2.1.0 so generate new API tokens for each user
    const users = await Database.userModel.getOldUsers()
    if (users.length) {
      for (const user of users) {
        user.token = await this.generateAccessToken({ userId: user.id, username: user.username })
      }
      await Database.updateBulkUsers(users)
    }
  }

  /**
   * Checks if the user in the validated jwt_payload really exists and is active.
   * @param {Object} jwt_payload 
   * @param {function} done 
   */
  async jwtAuthCheck(jwt_payload, done) {
    // load user by id from the jwt token
    const user = await Database.userModel.getUserByIdOrOldId(jwt_payload.userId)

    if (!user?.isActive) {
      // deny login
      done(null, null)
      return
    }
    // approve login
    done(null, user)
    return
  }

  /**
   * Checks if a username and password tuple is valid and the user active.
   * @param {string} username 
   * @param {string} password 
   * @param {function} done 
   */
  async localAuthCheckUserPw(username, password, done) {
    // Load the user given it's username
    const user = await Database.userModel.getUserByUsername(username.toLowerCase())

    if (!user || !user.isActive) {
      done(null, null)
      return
    }

    // Check passwordless root user
    if (user.type === 'root' && (!user.pash || user.pash === '')) {
      if (password) {
        // deny login
        done(null, null)
        return
      }
      // approve login
      done(null, user)
      return
    }

    // Check password match
    const compare = await bcrypt.compare(password, user.pash)
    if (compare) {
      // approve login
      done(null, user)
      return
    }
    // deny login
    done(null, null)
    return
  }

  /**
   * Hashes a password with bcrypt.
   * @param {string} password 
   * @returns {string} hash 
   */
  hashPass(password) {
    return new Promise((resolve) => {
      bcrypt.hash(password, 8, (err, hash) => {
        if (err) {
          resolve(null)
        } else {
          resolve(hash)
        }
      })
    })
  }

  /**
   * Return the login info payload for a user
   * 
   * @param {Object} user 
   * @returns {Promise<Object>} jsonPayload
   */
  async getUserLoginResponsePayload(user) {
    const libraryIds = await Database.libraryModel.getAllLibraryIds()
    return {
      user: user.toJSONForBrowser(),
      userDefaultLibraryId: user.getDefaultLibraryId(libraryIds),
      serverSettings: Database.serverSettings.toJSONForBrowser(),
      ereaderDevices: Database.emailSettings.getEReaderDevices(user),
      Source: global.Source
    }
  }

  async createNewUserViaEmail(email, requestedUsername) {
    // check if user anlready exists
    var user = await Database.userModel.getUserByEmail(email)
    if (user) {
      // user already exists
      return null
    }

    // Find a free username
    var username = requestedUsername
    var i = 1
    do {
      var usernameExists = await Database.userModel.getUserByUsername(username)
      if (!usernameExists) {
        break;
      }
      username = `requestedUsername${i}`
      i = i + 1
    }
    while (true)

    const newUserData = {
      id: uuidv4(),
      username: username,
      type: "user",
      pash: await this.hashPass(account.password),
      createdAt: Date.now(),
      isActive: true,
      isLocked: false,
    }

    newUserData.token = await this.generateAccessToken(newUserData)

    const newUser = new User(account)

    const success = await Database.createUser(newUser)
    if (success) {
      return newUser
    } else {
      return null
    }

  }
}

module.exports = Auth