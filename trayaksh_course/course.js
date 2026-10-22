/**
 * TrayakshAI - Course Page Interactive Engine
 * Handling: Urgency Countdown, Razorpay Gateway, Auth & Google Sign-In, Forgot Password Wizard, Curriculum Filters, FAQs
 */

(function () {
  'use strict';

  // =========================================================================
  // 1. CONFIGURATION & STATE
  // =========================================================================
  const API_BASE = window.COURSE_API_URL || 
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
      ? 'http://localhost:10000/api' 
      : 'https://trayakshai.onrender.com/api');

  const CONFIG = {
    razorpayKeyId: '',
    companyName: 'TrayakshAI',
    supportEmail: 'hello@trayakshai.com',
    targetDeadlineString: '23 October 2026',
    targetDeadlineYear: 2026,
    targetDeadlineMonth: 9, // October (0-indexed: 9 = October)
    targetDeadlineDay: 23,
    plans: {
      registration: {
        id: 'plan_reg_9999',
        name: 'Seat Registration Fee',
        amount: 9999,
        amountPaise: 999900,
        description: 'TrayakshAI Registration Fee (Course fee ₹49,999 applicable after registering)'
      },
      course_fee: {
        id: 'plan_course_49999',
        name: 'Course Fee',
        amount: 49999,
        amountPaise: 4999900,
        description: 'TrayakshAI AI Infrastructure Training — Course Fee (Applicable after registering)'
      }
    }
  };

  // State Management (Session vs Local Storage based on Remember Me)
  function getStoredItem(key) {
    try {
      return localStorage.getItem(key) || sessionStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function readStoredJson(key) {
    try {
      const value = getStoredItem(key);
      return value ? JSON.parse(value) : null;
    } catch (err) {
      return null;
    }
  }

  function setStoredItem(key, value, remember = true) {
    try {
      if (remember) {
        localStorage.setItem(key, value);
        sessionStorage.removeItem(key);
      } else {
        sessionStorage.setItem(key, value);
        localStorage.removeItem(key);
      }
    } catch (_) {}
  }

  function removeStoredItem(key) {
    try {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    } catch (_) {}
  }

  window.getStoredItem = getStoredItem;
  window.readStoredJson = readStoredJson;
  window.setStoredItem = setStoredItem;
  window.removeStoredItem = removeStoredItem;

  let currentUser = readStoredJson('trayaksh_user');
  let currentEnrollment = readStoredJson('trayaksh_enrollment');

  function syncEnrollmentFromApi(enrollment, user, remember = true) {
    if (!enrollment || !enrollment.regId) {
      currentEnrollment = null;
      removeStoredItem('trayaksh_enrollment');
      return;
    }
    const isCourseFee = enrollment.plan === 'course_fee';
    currentEnrollment = {
      regId: enrollment.regId,
      planName: isCourseFee ? 'Course Fee' : 'Seat Registration Fee',
      amount: isCourseFee ? 49999 : 9999,
      userName: user && user.name || currentUser && currentUser.name || 'Candidate',
      userEmail: user && user.email || currentUser && currentUser.email || '',
      status: enrollment.status || 'active',
      date: enrollment.enrolledAt ? new Date(enrollment.enrolledAt).toLocaleDateString('en-IN') : 'Active'
    };
    setStoredItem('trayaksh_enrollment', JSON.stringify(currentEnrollment), remember);
  }

  async function apiRequest(endpoint, method = 'GET', data = null, customToken = null) {
    let token = customToken;
    if (!token) {
      if (endpoint.startsWith('/admin')) {
        token = getStoredItem('trayaksh_admin_token') || getStoredItem('trayaksh_token');
      } else {
        token = getStoredItem('trayaksh_token') || getStoredItem('trayaksh_admin_token');
      }
    }
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const fetchConfig = { method, headers };
    if (data && method !== 'GET') {
      fetchConfig.body = JSON.stringify(data);
    }

    const controller = new AbortController();
    const timeoutMs = endpoint === '/classroom/lab-exec' ? 15000 : 10000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    fetchConfig.signal = controller.signal;

    try {
      const response = await fetch(`${API_BASE}${endpoint}`, fetchConfig);
      clearTimeout(timeout);
      const json = await response.json();
      if (!response.ok) {
        const error = new Error(json.error || json.message || `Request failed with status ${response.status}`);
        error.status = response.status;
        error.data = json;
        Object.assign(error, json);
        throw error;
      }
      return json;
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  // Exported Full-Stack API Engine
  window.TrayakshAPI = {
    apiBase: API_BASE,
    request: apiRequest,
    login: (email, password) => apiRequest('/auth/login', 'POST', { email, password }),
    register: (payload) => apiRequest('/auth/register', 'POST', {
      ...payload,
      full_name: payload.full_name || payload.name,
      name: payload.name || payload.full_name
    }),
    googleAuth: (credential) => apiRequest('/auth/google', 'POST', { credential }),
    getMe: () => apiRequest('/auth/me', 'GET'),
    createOrder: (planKey, candidate) => apiRequest('/payment/create-order', 'POST', {
      plan_type: planKey,
      planKey,
      ...candidate
    }),
    verifyPayment: (payload) => apiRequest('/payment/verify', 'POST', {
      ...payload,
      candidate_data: payload.candidate_data || {
        name: payload.name,
        email: payload.email,
        phone: payload.phone,
        company: payload.company,
        gstin: payload.gstin
      }
    }),
    getClassroomModules: () => apiRequest('/classroom/modules', 'GET'),
    downloadBlueprint: (moduleId) => apiRequest(`/classroom/blueprint/${moduleId}`, 'GET'),
    executeLabCommand: (command) => apiRequest('/classroom/lab-exec', 'POST', { command }),
    getOrderStatus: (orderId) => apiRequest(`/payment/status/${orderId}`, 'GET'),
    sendVerificationCode: (email) => apiRequest('/auth/send-verification-code', 'POST', { email }),
    getGoogleConfig: () => apiRequest('/auth/google-config', 'GET'),
    adminLogin: (email, password, twoFactorCode) => apiRequest('/admin/login', 'POST', { email, password, twoFactorCode }),
    getAdminSession: () => apiRequest('/admin/session', 'GET'),
    getAdminCandidates: () => apiRequest('/admin/candidates', 'GET'),
    getAdminAuditLogs: () => apiRequest('/admin/audit-logs', 'GET'),
    recordAdminAuditEvent: (event) => apiRequest('/admin/audit-logs', 'POST', { event }),
    getCohortSettings: () => apiRequest('/admin/cohort-settings', 'GET'),
    saveCohortSettings: (settings) => apiRequest('/admin/cohort-settings', 'POST', settings),
    createAdminModule: (payload) => apiRequest('/admin/modules', 'POST', payload),
    deleteAdminModule: (id) => apiRequest(`/admin/modules/${id}`, 'DELETE'),
    sendAdminCandidateSsh: (email) => apiRequest('/admin/send-ssh-keys', 'POST', { email }),
    changeAdminPassword: (currentPassword, newPassword) => apiRequest('/admin/change-password', 'POST', { currentPassword, newPassword }),
    getAdmin2FASettings: () => apiRequest('/admin/2fa-settings', 'GET'),
    toggleAdmin2FA: (enabled) => apiRequest('/admin/toggle-2fa', 'POST', { enabled }),
    getGatewaySettings: () => apiRequest('/admin/gateway-settings', 'GET'),
    saveGatewaySettings: (settings) => apiRequest('/admin/gateway-settings', 'POST', settings)
  };

  // Intent-Based Redirection Helper (Strictly Relative Routes, No javascript: XSS)
  window.getSafeReturnUrl = function (defaultUrl = 'classroom.html') {
    const params = new URLSearchParams(window.location.search);
    let returnTo = params.get('returnTo');
    if (!returnTo) return defaultUrl;

    try {
      returnTo = decodeURIComponent(returnTo).trim();
    } catch (e) {
      return defaultUrl;
    }

    // Explicitly reject dangerous pseudo-protocols, absolute URLs, backslashes, and protocol-relative slashes
    if (/^(javascript|data|vbscript|file):/i.test(returnTo)) {
      return defaultUrl;
    }
    if (returnTo.includes('://') || returnTo.startsWith('//') || returnTo.includes('\\')) {
      return defaultUrl;
    }

    // Strip leading slashes to enforce strictly relative navigation
    const cleanPath = returnTo.replace(/^\/+/, '');
    
    // Whitelist known safe local application routes
    const ALLOWED_ROUTES = [
      'classroom.html',
      'register.html',
      'index.html',
      'login.html',
      'course-upload.html',
      'admin-login.html'
    ];
    
    const baseFile = cleanPath.split('?')[0].split('#')[0];
    if (ALLOWED_ROUTES.includes(baseFile)) {
      return cleanPath;
    }
    return defaultUrl;
  };

  window.requireAuthWithRedirect = function (targetUrl) {
    const cleanTarget = encodeURIComponent(targetUrl || (window.location.pathname.split('/').pop() + window.location.search));
    window.location.href = `login.html?returnTo=${cleanTarget}`;
  };

  // =========================================================================
  // 2. DYNAMIC COUNTDOWN TIMER (TARGET: 23 OCTOBER 2026)
  // =========================================================================
  function initCountdown() {
    const daysEl = document.getElementById('cd-days');
    const hoursEl = document.getElementById('cd-hours');
    const minsEl = document.getElementById('cd-mins');
    const secsEl = document.getElementById('cd-secs');

    if (!daysEl) return;

    function getTargetDeadline() {
      // Explicitly 23 October 2026 at 23:59:59 IST (+05:30)
      return new Date('2026-10-23T23:59:59+05:30');
    }

    const deadline = getTargetDeadline();

    function updateTimer() {
      const now = new Date().getTime();
      const diff = deadline.getTime() - now;

      if (diff <= 0) {
        daysEl.textContent = '00';
        hoursEl.textContent = '00';
        minsEl.textContent = '00';
        secsEl.textContent = '00';
        return;
      }

      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const secs = Math.floor((diff % (1000 * 60)) / 1000);

      daysEl.textContent = String(days).padStart(2, '0');
      hoursEl.textContent = String(hours).padStart(2, '0');
      minsEl.textContent = String(mins).padStart(2, '0');
      secsEl.textContent = String(secs).padStart(2, '0');
    }

    updateTimer();
    setInterval(updateTimer, 1000);
  }

  // =========================================================================
  // 3. TOAST NOTIFICATIONS
  // =========================================================================
  window.showToast = function (message, type = 'success') {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let icon = '✓';
    if (type === 'error') icon = '✕';
    if (type === 'warn') icon = '⚠';
    if (type === 'info') icon = 'ℹ';

    const iconSpan = document.createElement('span');
    iconSpan.style.cssText = 'font-weight:bold;font-size:16px;';
    iconSpan.textContent = icon;

    const messageDiv = document.createElement('div');
    messageDiv.textContent = message;

    toast.appendChild(iconSpan);
    toast.appendChild(messageDiv);
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4200);
  };

  // =========================================================================
  // 4. USER AUTHENTICATION & SESSION HANDLING
  // =========================================================================
  function updateUserNavState() {
    const navAuthButtons = document.getElementById('nav-auth-buttons');
    const navUserPill = document.getElementById('nav-user-pill');
    const userNameDisplay = document.getElementById('nav-user-name');
    const userAvatarDisplay = document.getElementById('nav-user-avatar');
    const userDropdownEmail = document.getElementById('user-dropdown-email');

    // Mobile drawer auth state elements
    const mobGuest = document.getElementById('mobile-nav-auth-guest');
    const mobUser = document.getElementById('mobile-nav-auth-user');
    const mobUserName = document.getElementById('mobile-user-name');
    const mobUserEmail = document.getElementById('mobile-user-email');
    const mobUserAvatar = document.getElementById('mobile-user-avatar');

    if (currentUser) {
      if (navAuthButtons) navAuthButtons.style.display = 'none';
      if (navUserPill) {
        navUserPill.style.display = 'inline-flex';
        const nameParts = (currentUser.name || 'User').split(' ');
        const initials = nameParts.map(n => n[0]).join('').substring(0, 2).toUpperCase();
        if (userNameDisplay) userNameDisplay.textContent = currentUser.name;
        if (userAvatarDisplay) userAvatarDisplay.textContent = initials || 'AI';
        if (userDropdownEmail) userDropdownEmail.textContent = currentUser.email;

        if (mobGuest) mobGuest.style.display = 'none';
        if (mobUser) mobUser.style.display = 'block';
        if (mobUserName) mobUserName.textContent = currentUser.name;
        if (mobUserEmail) mobUserEmail.textContent = currentUser.email;
        if (mobUserAvatar) mobUserAvatar.textContent = initials || 'AI';
      }
    } else {
      if (navAuthButtons) navAuthButtons.style.display = 'inline-flex';
      if (navUserPill) navUserPill.style.display = 'none';

      if (mobGuest) mobGuest.style.display = 'flex';
      if (mobUser) mobUser.style.display = 'none';
    }
  }

  window.openAuthModal = function (tab = 'signin') {
    const modal = document.getElementById('auth-modal');
    if (!modal) return;
    modal.classList.add('active');
    switchAuthTab(tab);
  };

  window.closeAuthModal = function () {
    const modal = document.getElementById('auth-modal');
    if (modal) modal.classList.remove('active');
  };

  window.switchAuthTab = function (tab) {
    const signinForm = document.getElementById('auth-signin-form');
    const signupForm = document.getElementById('auth-signup-form');
    const forgotForm = document.getElementById('auth-forgot-form');
    const tabSigninBtn = document.getElementById('tab-btn-signin');
    const tabSignupBtn = document.getElementById('tab-btn-signup');

    if (tab === 'signin') {
      if (signinForm) signinForm.style.display = 'block';
      if (signupForm) signupForm.style.display = 'none';
      if (forgotForm) forgotForm.style.display = 'none';
      if (tabSigninBtn) tabSigninBtn.classList.add('active');
      if (tabSignupBtn) tabSignupBtn.classList.remove('active');
    } else if (tab === 'signup') {
      if (signinForm) signinForm.style.display = 'none';
      if (signupForm) signupForm.style.display = 'block';
      if (forgotForm) forgotForm.style.display = 'none';
      if (tabSigninBtn) tabSigninBtn.classList.remove('active');
      if (tabSignupBtn) tabSignupBtn.classList.add('active');
    } else if (tab === 'forgot') {
      if (signinForm) signinForm.style.display = 'none';
      if (signupForm) signupForm.style.display = 'none';
      if (forgotForm) forgotForm.style.display = 'block';
      if (tabSigninBtn) tabSigninBtn.classList.remove('active');
      if (tabSignupBtn) tabSignupBtn.classList.remove('active');
    }
  };

  window.handleSignIn = async function (e) {
    if (e) e.preventDefault();
    const email = document.getElementById('signin-email').value.trim();
    const password = document.getElementById('signin-password').value;
    const remember = document.getElementById('signin-remember') ? document.getElementById('signin-remember').checked : true;

    if (!email || !password) {
      showToast('Please enter both email and password.', 'error');
      return;
    }

    try {
      showToast('Authenticating with TrayakshAI security service...', 'info');
      const data = await window.TrayakshAPI.login(email, password);
      removeStoredItem('trayaksh_admin_user');
      removeStoredItem('trayaksh_admin_token');
      removeStoredItem('trayaksh_admin_auth');
      currentUser = data.user;
      setStoredItem('trayaksh_user', JSON.stringify(currentUser), remember);
      if (data.token) setStoredItem('trayaksh_token', data.token, remember);
      syncEnrollmentFromApi(data.enrollment, currentUser, remember);
      updateUserNavState();
      closeAuthModal();
      showToast(`Welcome back, ${currentUser.name}!`, 'success');
      return data;
    } catch (err) {
      console.error('Sign-in failed:', err.message);
      showToast(err.message || 'Authentication failed. Please verify your credentials.', 'error');
      throw err;
    }
  };

  window.handleSignUp = async function (e) {
    if (e) e.preventDefault();
    const name = document.getElementById('signup-name').value.trim();
    const email = document.getElementById('signup-email').value.trim();
    const phone = document.getElementById('signup-phone').value.trim();
    const role = document.getElementById('signup-role').value;
    const password = document.getElementById('signup-password').value;

    if (!name || !email || !password) {
      showToast('Please fill in all required fields.', 'error');
      return;
    }

    try {
      showToast('Creating candidate account in PostgreSQL...', 'info');
      const data = await window.TrayakshAPI.register({ name, email, phone, role, password });
      currentUser = data.user;
      setStoredItem('trayaksh_user', JSON.stringify(currentUser), true);
      if (data.token) setStoredItem('trayaksh_token', data.token, true);
      syncEnrollmentFromApi(data.enrollment, currentUser, true);
      updateUserNavState();
      closeAuthModal();
      showToast(`Account created successfully! Welcome to TrayakshAI, ${name}.`, 'success');
      return data;
    } catch (err) {
      console.error('Registration failed:', err.message);
      showToast(err.message || 'Registration failed. Please check details and try again.', 'error');
      throw err;
    }
  };

  // Google Authentication Handler
  let pendingGoogleCredential = null;
  let initializedGoogleClientId = null;

  async function requestGoogleCredential() {
    if (!window.google || !window.google.accounts || !window.google.accounts.id) {
      throw new Error('Google sign-in is still loading. Please try again in a moment.');
    }

    const config = await window.TrayakshAPI.getGoogleConfig();
    if (!config || !config.clientId) {
      throw new Error('Google sign-in is not configured for this site.');
    }

    if (initializedGoogleClientId && initializedGoogleClientId !== config.clientId) {
      throw new Error('Google sign-in configuration changed. Reload the page and try again.');
    }

    if (!initializedGoogleClientId) {
      window.google.accounts.id.initialize({
        client_id: config.clientId,
        callback: (response) => {
          const pending = pendingGoogleCredential;
          pendingGoogleCredential = null;
          if (pending) {
            clearTimeout(pending.timeout);
            if (response && response.credential) pending.resolve(response.credential);
            else pending.reject(new Error('Google did not return an identity credential.'));
          }
        }
      });
      initializedGoogleClientId = config.clientId;
    }

    return new Promise((resolve, reject) => {
      if (pendingGoogleCredential) {
        clearTimeout(pendingGoogleCredential.timeout);
        pendingGoogleCredential.reject(new Error('A Google sign-in request was replaced.'));
      }
      const pending = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          if (pendingGoogleCredential === pending) pendingGoogleCredential = null;
          reject(new Error('Google sign-in was not completed. Please try again.'));
        }, 60000)
      };
      pendingGoogleCredential = pending;
      window.google.accounts.id.prompt((notification) => {
        if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
          if (pendingGoogleCredential === pending) pendingGoogleCredential = null;
          clearTimeout(pending.timeout);
          reject(new Error('Google sign-in was not displayed. Check the site OAuth configuration and try again.'));
        }
      });
    });
  }

  window.handleGoogleAuth = async function (credential) {
    try {
      const effectiveCredential = credential || await requestGoogleCredential();
      showToast('Authenticating with Google Identity Services...', 'info');
      const data = await window.TrayakshAPI.googleAuth(effectiveCredential);
      if (!data || !data.token) {
        throw new Error(data && data.error ? data.error : 'Google auth did not return a valid session token.');
      }
      const remember = document.getElementById('signin-remember') ? document.getElementById('signin-remember').checked : true;
      removeStoredItem('trayaksh_admin_user');
      removeStoredItem('trayaksh_admin_token');
      removeStoredItem('trayaksh_admin_auth');
      currentUser = data.user;
      setStoredItem('trayaksh_user', JSON.stringify(currentUser), remember);
      setStoredItem('trayaksh_token', data.token, remember);
      syncEnrollmentFromApi(data.enrollment, currentUser, remember);
      updateUserNavState();
      closeAuthModal();
      showToast(`Google authenticated as ${currentUser.name}!`, 'success');
      return data;
    } catch (err) {
      console.warn('Google backend verification notice:', err.message);
      showToast(err.message || 'Google authentication failed.', 'error');
      throw err;
    }
  };

  // Forgot Password Wizard Steps
  window.handleForgotStep1 = function (e) {
    e.preventDefault();
    const email = document.getElementById('forgot-email').value.trim();
    if (!email) {
      showToast('Please enter your registered email.', 'error');
      return;
    }

    showToast(`To protect enterprise security, password resets are processed via support verification. Please reach out to hello@trayakshai.com`, 'info');
  };

  window.handleForgotStep2 = function (e) {
    e.preventDefault();
    showToast('Direct self-service password reset is disabled for enterprise security. Contact hello@trayakshai.com.', 'info');
  };

  window.handleSignOut = function () {
    currentUser = null;
    currentEnrollment = null;
    removeStoredItem('trayaksh_user');
    removeStoredItem('trayaksh_token');
    removeStoredItem('trayaksh_enrollment');
    removeStoredItem('trayaksh_admin_user');
    removeStoredItem('trayaksh_admin_token');
    removeStoredItem('trayaksh_admin_auth');
    updateUserNavState();
    toggleUserDropdown(false);
    showToast('You have been signed out successfully.', 'info');
  };

  window.toggleUserDropdown = function (forceState) {
    const dropdown = document.getElementById('user-dropdown-menu');
    if (!dropdown) return;
    if (typeof forceState === 'boolean') {
      if (forceState) dropdown.classList.add('active');
      else dropdown.classList.remove('active');
    } else {
      dropdown.classList.toggle('active');
    }
  };

  // Mobile Navigation Drawer Toggle & Handler
  window.toggleMobileMenu = function (forceState) {
    const drawer = document.getElementById('mobile-nav-drawer');
    const backdrop = document.getElementById('mobile-nav-backdrop');
    const toggleBtn = document.getElementById('mobile-menu-btn');
    if (!drawer) return;

    const isOpen = drawer.classList.contains('active');
    const nextState = typeof forceState === 'boolean' ? forceState : !isOpen;

    if (nextState) {
      drawer.classList.add('active');
      if (backdrop) backdrop.classList.add('active');
      if (toggleBtn) {
        toggleBtn.classList.add('active');
        toggleBtn.setAttribute('aria-expanded', 'true');
      }
      document.body.style.overflow = 'hidden';
    } else {
      drawer.classList.remove('active');
      if (backdrop) backdrop.classList.remove('active');
      if (toggleBtn) {
        toggleBtn.classList.remove('active');
        toggleBtn.setAttribute('aria-expanded', 'false');
      }
      document.body.style.overflow = '';
    }
  };

  // Close mobile drawer on Escape key or window resize above 1080px
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      window.toggleMobileMenu(false);
      window.toggleUserDropdown(false);
    }
  });

  window.addEventListener('resize', function () {
    if (window.innerWidth > 1080) {
      window.toggleMobileMenu(false);
    }
  });

  // =========================================================================
  // 5. RAZORPAY CHECKOUT GATEWAY INTEGRATION
  // =========================================================================
  let selectedCheckoutPlan = 'registration'; // 'registration' (₹9,999) or 'course_fee' (₹49,999)

  window.openCheckout = function (planKey = 'registration') {
    if (planKey === 'full') planKey = 'course_fee';
    selectedCheckoutPlan = planKey;
    const modal = document.getElementById('checkout-modal');
    if (!modal) return;

    // Update plan selection visually
    const regOpt = document.getElementById('plan-opt-reg');
    const fullOpt = document.getElementById('plan-opt-full');

    if (planKey === 'registration') {
      if (regOpt) regOpt.classList.add('selected');
      if (fullOpt) fullOpt.classList.remove('selected');
    } else {
      if (regOpt) regOpt.classList.remove('selected');
      if (fullOpt) fullOpt.classList.add('selected');
    }

    // Pre-fill user data if logged in
    if (currentUser) {
      const nameInput = document.getElementById('checkout-name');
      const emailInput = document.getElementById('checkout-email');
      const phoneInput = document.getElementById('checkout-phone');
      if (nameInput && !nameInput.value) nameInput.value = currentUser.name || '';
      if (emailInput && !emailInput.value) emailInput.value = currentUser.email || '';
      if (phoneInput && !phoneInput.value && currentUser.phone) phoneInput.value = currentUser.phone;
    }

    updateCheckoutSummary();
    modal.classList.add('active');
  };

  window.selectCheckoutPlan = function (planKey) {
    selectedCheckoutPlan = planKey;
    const regOpt = document.getElementById('plan-opt-reg');
    const fullOpt = document.getElementById('plan-opt-full');

    if (planKey === 'registration') {
      if (regOpt) regOpt.classList.add('selected');
      if (fullOpt) fullOpt.classList.remove('selected');
    } else {
      if (regOpt) regOpt.classList.remove('selected');
      if (fullOpt) fullOpt.classList.add('selected');
    }
    updateCheckoutSummary();
  };

  function updateCheckoutSummary() {
    const plan = CONFIG.plans[selectedCheckoutPlan] || CONFIG.plans.registration;
    const totalEl = document.getElementById('checkout-summary-amount');
    const btnTextEl = document.getElementById('checkout-pay-btn-text');

    if (totalEl) totalEl.textContent = `₹${plan.amount.toLocaleString('en-IN')}`;
    if (btnTextEl) {
      if (selectedCheckoutPlan === 'registration') {
        btnTextEl.textContent = `Pay Registration Fee (₹9,999) →`;
      } else {
        btnTextEl.textContent = `Pay Course Fee (₹49,999) →`;
      }
    }
  }

  window.closeCheckoutModal = function () {
    const modal = document.getElementById('checkout-modal');
    if (modal) modal.classList.remove('active');
  };

  // Generalized payment trigger supporting both modal checkout and standalone registration
  window.triggerPayment = async function (data, planKey = 'registration') {
    const plan = CONFIG.plans[planKey] || CONFIG.plans.registration;
    const name = data.name || (currentUser ? currentUser.name : '');
    const email = data.email || (currentUser ? currentUser.email : '');
    const phone = data.phone || (currentUser ? currentUser.phone : '');
    const company = data.company || '';
    const gstin = data.gstin || '';

    if (!name || !email || !phone) {
      showToast('Please fill in your Name, Email, and Phone Number.', 'error');
      return;
    }

    showToast('Initializing secure order with payment gateway...', 'info');

    // Attempt server-side order generation from backend
    let backendOrder = null;
    try {
      backendOrder = await window.TrayakshAPI.createOrder(planKey, { name, email, phone, company, gstin });
    } catch (err) {
      console.warn('Backend createOrder notice:', err.message);
      if (err.message && (err.message.includes('already exists') || err.message.includes('log in') || err.message.includes('sign in'))) {
        showToast(err.message, 'warn');
        setTimeout(() => {
          window.location.href = `login.html?returnTo=${encodeURIComponent('classroom.html')}`;
        }, 1500);
        return;
      }
      showToast(`Could not start secure payment: ${err.message || 'payment service unavailable.'}`, 'error');
      return;
    }

    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const effectiveKeyId = backendOrder && backendOrder.keyId;
    const isPlaceholderKey = !effectiveKeyId;
    const orderId = backendOrder && backendOrder.orderId;
    if (!orderId) {
      showToast('The payment service did not return a server order. No payment was started.', 'error');
      return;
    }

    // If a valid live or test key is present and Razorpay SDK is available
    if (!isPlaceholderKey && typeof Razorpay !== 'undefined') {
      const options = {
        key: effectiveKeyId,
        amount: (backendOrder && backendOrder.amount) || plan.amountPaise,
        currency: 'INR',
        name: 'TrayakshAI Consulting',
        description: `${plan.name} — AI Infrastructure & AI Factory Training`,
        image: 'assets/logo.png',
        order_id: orderId,
        prefill: {
          name: name,
          email: email,
          contact: phone
        },
        notes: {
          plan: planKey,
          company: company || 'Individual',
          gstin: gstin || 'Not Provided',
          course: 'AI Infrastructure & AI Factory Training',
          registration_deadline: '23 October 2026'
        },
        theme: {
          color: '#1E9E4A'
        },
        modal: {
          ondismiss: function () {
            showToast('Payment window closed. Your registration is pending.', 'warn');
          }
        },
        handler: async function (response) {
          showToast('Verifying payment signature with Trayaksh security backend...', 'info');
          let verifyData = null;
          try {
            verifyData = await window.TrayakshAPI.verifyPayment({
              razorpay_order_id: response.razorpay_order_id || orderId,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
              planKey: planKey,
              name,
              email,
              phone,
              company,
              gstin,
              candidate_data: {
                name,
                email,
                phone,
                company,
                gstin
              }
            });
          } catch (vErr) {
            console.error('Backend payment verification failed:', vErr.message);
            showToast(`Payment verification rejected: ${vErr.message || 'Signature check failed.'}`, 'error');
            return; // ABORT: Do not display confirmed receipt if backend rejected verification
          }

          if (!verifyData || !verifyData.success) {
            showToast('Payment verification was not confirmed by the server.', 'error');
            return;
          }

          if (verifyData.token) {
            localStorage.setItem('trayaksh_token', verifyData.token);
          }
          if (verifyData.user) {
            currentUser = verifyData.user;
            localStorage.setItem('trayaksh_user', JSON.stringify(currentUser));
            updateUserNavState();
          }

          handlePaymentSuccess({
            paymentId: response.razorpay_payment_id,
            orderId: response.razorpay_order_id || orderId,
            signature: response.razorpay_signature || 'verified',
            registrationId: (verifyData.enrollment && verifyData.enrollment.registrationId) ? verifyData.enrollment.registrationId : undefined,
            name,
            email,
            phone,
            company,
            gstin,
            plan,
            requiresLogin: verifyData.requiresLogin
          });
        }
      };

      try {
        const rzp = new Razorpay(options);
        rzp.on('payment.failed', function (response) {
          showToast(`Payment failed: ${response.error.description}`, 'error');
        });
        rzp.open();
      } catch (err) {
        console.warn('Razorpay SDK init error:', err);
        if (!isLocalhost) {
          showToast('Payment gateway failed to initialize. Please reload or contact info@trayakshai.com.', 'error');
          return;
        }
        launchSimulationPayment(name, email, phone, company, gstin, plan, orderId);
      }
    } else {
      // In development / sandbox mode on localhost
      if (!isLocalhost) {
        showToast('Payment gateway is awaiting production key activation. Please contact info@trayakshai.com.', 'error');
        return;
      }
      launchSimulationPayment(name, email, phone, company, gstin, plan, orderId);
    }
  };

  // Process Razorpay Payment from Modal
  window.handleCheckoutSubmit = function (e) {
    e.preventDefault();
    const name = document.getElementById('checkout-name').value.trim();
    const email = document.getElementById('checkout-email').value.trim();
    const phone = document.getElementById('checkout-phone').value.trim();
    const company = document.getElementById('checkout-company').value.trim();
    const gstin = document.getElementById('checkout-gstin').value.trim();

    triggerPayment({ name, email, phone, company, gstin }, selectedCheckoutPlan);
  };

  function launchSimulationPayment(name, email, phone, company, gstin, plan, existingOrderId) {
    showToast('Processing secure transaction via Razorpay Sandbox...', 'info');
    setTimeout(async () => {
      const mockPaymentId = `pay_sim_${Math.random().toString(36).substring(2, 12).toUpperCase()}`;
      const mockOrderId = existingOrderId || `order_sim_${Date.now().toString().slice(-8)}`;

      let verifyData = null;
      try {
        verifyData = await window.TrayakshAPI.verifyPayment({
          razorpay_order_id: mockOrderId,
          razorpay_payment_id: mockPaymentId,
          razorpay_signature: 'simulated_valid_sha256',
          planKey: plan.id ? (plan.id.includes('course') ? 'course_fee' : 'registration') : 'registration',
          name,
          email,
          phone,
          company,
          gstin
        });
      } catch (err) {
        console.error('Sandbox backend verification failed:', err.message);
        showToast(`Payment verification rejected: ${err.message}`, 'error');
        return; // High Issue 4 Fix: NEVER show confirmed receipt if backend rejected verification!
      }

      if (!verifyData || !verifyData.success) {
        showToast('Payment verification was not confirmed by the server.', 'error');
        return; // High Issue 4 Fix: Abort on unsuccessful verification
      }

      if (verifyData.token) {
        localStorage.setItem('trayaksh_token', verifyData.token);
      }
      if (verifyData.user) {
        currentUser = verifyData.user;
        localStorage.setItem('trayaksh_user', JSON.stringify(currentUser));
        updateUserNavState();
      }

      handlePaymentSuccess({
        paymentId: mockPaymentId,
        orderId: mockOrderId,
        signature: 'simulated_valid_sha256',
        registrationId: (verifyData.enrollment && verifyData.enrollment.registrationId) ? verifyData.enrollment.registrationId : undefined,
        name,
        email,
        phone,
        company,
        gstin,
        plan,
        requiresLogin: verifyData.requiresLogin
      });
    }, 900);
  }

  function handlePaymentSuccess(data) {
    if (!data || !data.registrationId) {
      showToast('The server confirmed payment but did not return a registration ID. Contact support with your payment ID before retrying checkout.', 'error');
      return;
    }
    closeCheckoutModal();

    const regId = data.registrationId;
    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

    currentEnrollment = {
      regId: regId,
      paymentId: data.paymentId,
      orderId: data.orderId,
      amount: data.plan.amount,
      planName: data.plan.name,
      userName: data.name,
      userEmail: data.email,
      phone: data.phone,
      company: data.company,
      gstin: data.gstin,
      date: timestamp,
      status: 'Confirmed'
    };

    localStorage.setItem('trayaksh_enrollment', JSON.stringify(currentEnrollment));
    showToast(`Payment verified! Registration ID: ${regId}`, 'success');

    if (data.requiresLogin) {
      showToast('Payment confirmed! Please sign in with your credentials to access your classroom.', 'info');
      setTimeout(() => {
        window.location.href = 'login.html?returnTo=classroom.html';
      }, 1800);
      return;
    }

    // Also persist user if not logged in
    if (!currentUser) {
      currentUser = {
        name: data.name,
        email: data.email,
        phone: data.phone,
        role: data.company ? `Architect (${data.company})` : 'Enterprise Member'
      };
      localStorage.setItem('trayaksh_user', JSON.stringify(currentUser));
      updateUserNavState();
    }

    showReceiptModal(currentEnrollment);
    showToast('Payment confirmed. Your registration slip is ready, and published lessons are available in the classroom.', 'success');
  }

  // =========================================================================
  // 6. RECEIPT & SYLLABUS UNLOCK MODAL
  // =========================================================================
  function showReceiptModal(enrollment) {
    const modal = document.getElementById('receipt-modal');
    if (!modal) return;

    document.getElementById('receipt-reg-id').textContent = enrollment.regId;
    document.getElementById('receipt-payment-id').textContent = enrollment.paymentId;
    document.getElementById('receipt-name').textContent = enrollment.userName;
    document.getElementById('receipt-email').textContent = enrollment.userEmail;
    document.getElementById('receipt-plan').textContent = enrollment.planName;
    document.getElementById('receipt-amount').textContent = `₹${enrollment.amount.toLocaleString('en-IN')}`;
    document.getElementById('receipt-date').textContent = enrollment.date;

    modal.classList.add('active');
  }

  window.closeReceiptModal = function () {
    const modal = document.getElementById('receipt-modal');
    if (modal) modal.classList.remove('active');
  };

  window.printReceipt = function () {
    window.print();
  };

  window.downloadSyllabusUnlocked = function () {
    showToast('Downloading the course curriculum overview. Published lessons and runbooks are available in the classroom.', 'info');
    const syllabusContent = `# TrayakshAI | AI Infrastructure & AI Factory Curriculum Overview
Access: Public curriculum overview. Lesson and lab access requires a verified enrollment.

============================================================
COURSE TRACKS:
============================================================

Track 01: AI Factory Architecture & Design
- Power Budgeting (40kW - 100kW+ Per Rack), PUE Optimization
- Liquid Cooling: CDUs, Secondary Loops, Manifolds, In-Row Heat Exchangers
- Multi-tier Network Cabling Plant & Spine-Leaf Topology

Track 02: NVIDIA DGX/HGX Infrastructure
- DGX H100, H200 & B200 SXM Baseboard Topologies
- NVSwitch 900GB/s to 1.8TB/s All-to-All Full Mesh Fabric
- Baseboard Management Controller (BMC), Redfish Automation & DCGM

Track 03: GPU Computing: H100, H200 & B200
- Hopper (GH100) vs Blackwell (B200/GB200) Microarchitecture
- FP8 & FP4 Micro-Scaling Formats, Transformer Engine Auto-Casting
- MIG (Multi-Instance GPU) Hardware Partitioning & QoS

Track 04: AI Networking: InfiniBand, RoCE & RDMA
- Quantum-2 400G & Quantum-X800 InfiniBand Fabrics
- RoCE v2, Lossless Ethernet (PFC & ECN Buffer Tuning)
- NCCL Tuning for Distributed Ring All-Reduce Collectives

Track 05: AI Storage & High-Performance Computing
- WEKA, Lustre & GPFS Parallel Storage Topologies
- GPUDirect Storage (GDS) DMA Bypassing CPU Memory
- High-IOPS Checkpointing Architecture for 70B+ LLM Training

Track 06: Kubernetes, Slurm & GPU Orchestration
- NVIDIA GPU Operator, Container Device Interface (CDI)
- Slurm Cluster Architecture, Backfill & Fair-share Scheduling
- Kubernetes Multi-Tenant Gang Scheduling (Kueue, KubeRay)

Track 07: Generative AI Infrastructure & LLM Deployment
- Distributed 3D Parallelism: Tensor (TP), Pipeline (PP), ZeRO-3
- Megatron-LM & DeepSpeed Cluster Sizing
- Production Inference: vLLM, TensorRT-LLM, PagedAttention

Track 08: AI Infrastructure Migration & Optimisation
- Cloud-to-Colo Repatriation Financial Modeling & TCO
- NVIDIA DCGM Telemetry, Prometheus & Grafana Dashboards
- Cutover Runbooks & 99.999% Reliability SRE Practices

============================================================
This overview does not include private lesson recordings, lab runbooks, or cluster credentials.
Support: hello@trayakshai.com | TrayakshAI Consulting Ltd.
`;

    const blob = new Blob([syllabusContent], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'TrayakshAI_AI_Factory_Curriculum_Overview.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // =========================================================================
  // 7. CURRICULUM FILTERS
  // =========================================================================
  function initCurriculumFilters() {
    const filterBtns = document.querySelectorAll('.filter-btn');
    const cards = document.querySelectorAll('.program-card');

    filterBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const category = btn.getAttribute('data-filter');

        cards.forEach(card => {
          if (category === 'all' || card.getAttribute('data-category') === category) {
            card.style.display = 'flex';
          } else {
            card.style.display = 'none';
          }
        });
      });
    });
  }

  // =========================================================================
  // 8. FAQ ACCORDION
  // =========================================================================
  function initFaqs() {
    const faqItems = document.querySelectorAll('.faq-item');
    faqItems.forEach(item => {
      const q = item.querySelector('.faq-question');
      if (q) {
        q.addEventListener('click', () => {
          const isActive = item.classList.contains('active');
          faqItems.forEach(i => i.classList.remove('active'));
          if (!isActive) {
            item.classList.add('active');
          }
        });
      }
    });
  }

  // Close dropdown on outside click
  document.addEventListener('click', function (e) {
    const navUserPill = document.getElementById('nav-user-pill');
    const userDropdown = document.getElementById('user-dropdown-menu');
    if (navUserPill && userDropdown && !navUserPill.contains(e.target)) {
      userDropdown.classList.remove('active');
    }
  });

  // =========================================================================
  // 10. INTERACTIVE AI FACTORY SIZING & ROI CALCULATOR ENGINE
  // =========================================================================
  function initRoiCalculator() {
    const gpuSlider = document.getElementById('calc-gpu-slider');
    const gpuCountDisplay = document.getElementById('calc-gpu-count');
    const cloudCostEl = document.getElementById('calc-cloud-cost');
    const factoryCostEl = document.getElementById('calc-factory-cost');
    const savingsEl = document.getElementById('calc-annual-savings');
    const powerEl = document.getElementById('calc-power-kw');
    const cduEl = document.getElementById('calc-cdu-flow');
    const fabricEl = document.getElementById('calc-fabric-switches');

    if (!gpuSlider) return;

    let selectedWorkload = 'pretrain';
    const workloadButtons = document.querySelectorAll('.calc-workload-btn');
    workloadButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        workloadButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedWorkload = btn.getAttribute('data-workload');
        updateRoiCalculations();
      });
    });

    function updateRoiCalculations() {
      const gpus = parseInt(gpuSlider.value, 10) || 16;
      if (gpuCountDisplay) gpuCountDisplay.textContent = `${gpus}x H100 SXM5`;

      let cloudHourlyRate = 4.50;
      let privateAmortizedRate = 1.25;

      if (selectedWorkload === 'finetune') {
        cloudHourlyRate = 4.20;
        privateAmortizedRate = 1.15;
      } else if (selectedWorkload === 'inference') {
        cloudHourlyRate = 3.90;
        privateAmortizedRate = 0.95;
      }

      const cloudMonthly = Math.round(gpus * cloudHourlyRate * 730);
      const factoryMonthly = Math.round(gpus * privateAmortizedRate * 730);
      const annualSavings = Math.round((cloudMonthly - factoryMonthly) * 12);

      const nodes = Math.ceil(gpus / 8);
      const totalPowerKw = Math.round(nodes * 10.2 + (nodes * 1.6));
      const cduFlowLitersMin = (nodes * 18.5).toFixed(1);
      const leafSwitches = Math.max(2, Math.ceil(gpus / 64) * 2);

      if (cloudCostEl) cloudCostEl.textContent = `$${cloudMonthly.toLocaleString('en-US')}/mo`;
      if (factoryCostEl) factoryCostEl.textContent = `$${factoryMonthly.toLocaleString('en-US')}/mo`;
      if (savingsEl) savingsEl.textContent = `$${annualSavings.toLocaleString('en-US')}`;
      if (powerEl) powerEl.textContent = `${totalPowerKw} kW`;
      if (cduEl) cduEl.textContent = `${cduFlowLitersMin} L/min`;
      if (fabricEl) fabricEl.textContent = `${leafSwitches}x QM9700 (400G)`;
    }

    gpuSlider.addEventListener('input', updateRoiCalculations);
    updateRoiCalculations();
  }

  // =========================================================================
  // 11. DYNAMIC LIVE CLUSTER TELEMETRY ENGINE
  // =========================================================================
  function initClusterTelemetry() {
    const ticker = document.getElementById('live-cluster-ticker');
    if (!ticker) return;

    const telemetryEvents = [
      'NVIDIA H100 SXM5 [Node 01..04]: 99.2% Tensor Active | FP8 Transformer Engine Enabled',
      'Quantum-2 InfiniBand Spine: 0.78μs All-to-All Latency | Non-blocking Fat-Tree Rail 1-8 UP',
      'Direct-to-Chip Liquid Loop: Coolant In 28.4°C / Out 39.1°C | CDU Loop Pressure 2.4 bar',
      'Slurm 23.02 Orchestrator: Job #98412 [Megatron-LM-70B] Alloc: 16 Nodes (128 GPUs)',
      'Parallel Storage (WEKA GDS): 148.6 GB/s Sustained Throughput | Direct DMA to HBM3'
    ];

    let index = 0;
    setInterval(() => {
      index = (index + 1) % telemetryEvents.length;
      ticker.style.opacity = '0';
      ticker.style.transform = 'translateY(-4px)';
      setTimeout(() => {
        ticker.textContent = telemetryEvents[index];
        ticker.style.opacity = '1';
        ticker.style.transform = 'translateY(0)';
      }, 300);
    }, 4500);
  }

  // =========================================================================
  // 12. UTILITY & INTERACTION ENHANCEMENTS
  // =========================================================================
  window.copyClusterCommand = function (text, btnElement) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        showToast('✓ Copied cluster execution command to clipboard!', 'success');
        if (btnElement) {
          const original = btnElement.innerHTML;
          btnElement.innerHTML = '✓ Copied';
          setTimeout(() => { btnElement.innerHTML = original; }, 2000);
        }
      }).catch(() => {
        showToast('Execution command: ' + text, 'info');
      });
    } else {
      showToast('Execution command: ' + text, 'info');
    }
  };

  // Medusa / Saleor session hydration on page load
  async function hydrateUserSession() {
    const token = getStoredItem('trayaksh_token');
    if (!token) return;

    try {
      const data = await window.TrayakshAPI.getMe();
      if (data && data.user) {
        currentUser = data.user;
        const isPersistent = Boolean(localStorage.getItem('trayaksh_token'));
        setStoredItem('trayaksh_user', JSON.stringify(data.user), isPersistent);
        syncEnrollmentFromApi(data.enrollment, data.user, isPersistent);
        updateUserNavState();
      }
    } catch (err) {
      if (err.status === 401) {
        currentUser = null;
        currentEnrollment = null;
        removeStoredItem('trayaksh_user');
        removeStoredItem('trayaksh_token');
        removeStoredItem('trayaksh_enrollment');
        updateUserNavState();
      }
      console.warn('Session hydration note:', err.message);
    }
  }

  // Skateshop / Bagisto deep-linking & intent redirection for curriculum cards
  function initCurriculumCardLinks() {
    const cards = document.querySelectorAll('.program-card');
    cards.forEach((card, idx) => {
      card.style.cursor = 'pointer';
      card.addEventListener('click', (e) => {
        if (e.target.closest('a') || e.target.closest('button')) return;
        const modId = `mod_${(idx % 5) + 1}`;
        const targetLessonUrl = `classroom.html?lesson=${modId}`;

        if (currentUser || currentEnrollment) {
          window.location.href = `classroom.html?lesson=${modId}`;
        } else {
          window.location.href = `login.html?returnTo=${encodeURIComponent(targetLessonUrl)}`;
        }
      });
    });
  }

  // =========================================================================
  // 13. INITIALIZATION ON DOM READY
  // =========================================================================
  document.addEventListener('DOMContentLoaded', function () {
    initCountdown();
    updateUserNavState();
    hydrateUserSession();
    initCurriculumFilters();
    initCurriculumCardLinks();
    initFaqs();
    initRoiCalculator();
    initClusterTelemetry();

    // Check if previously enrolled
    if (currentEnrollment) {
      console.log('Active Enrollment Found:', currentEnrollment.regId);
    }
  });

})();
