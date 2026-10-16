(() => {
  const $ = id => document.getElementById(id);
  let validatedInvite = '';
  const gate = $('invite-gate-form');
  const form = $('register-form');
  const status = $('register-status');
  const login = $('access-form');
  const loginLink = $('show-login');
  const invite = $('register-invite');

  function showInvite() {
    gate.classList.remove('hidden');
    form.classList.add('hidden');
    login.classList.add('hidden');
    loginLink.classList.remove('hidden');
    $('show-key-login')?.classList.add('hidden');
    status.textContent = '';
    validatedInvite = '';
  }
  function showLogin() {
    gate.classList.add('hidden');
    form.classList.add('hidden');
    login.classList.remove('hidden');
    loginLink.classList.add('hidden');
    $('show-key-login')?.classList.remove('hidden');
    status.textContent = '';
  }

  gate.addEventListener('submit', async event => {
    event.preventDefault();
    const code = invite.value.trim();
    const button = $('validate-invite-button');
    if (code.length < 20 || code.length > 200) {
      status.textContent = 'Pegá un código de invitación válido.';
      return;
    }
    button.disabled = true;
    status.textContent = '';
    try {
      const response = await fetch('/api/auth/validate-invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ invite: code })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.valid !== true) throw new Error(data.error || 'La invitación no es válida.');
      validatedInvite = code;
      gate.classList.add('hidden');
      form.classList.remove('hidden');
      loginLink.classList.add('hidden');
      $('show-key-login')?.classList.add('hidden');
      status.textContent = '';
      $('register-username').focus();
    } catch (error) {
      status.textContent = error.message;
      // Stay on the invite screen; offer login only as an explicit, separate action.
      loginLink.classList.remove('hidden');
    } finally {
      button.disabled = false;
    }
  });

  // Validate confirmation before the existing account-creation handler runs.
  form.addEventListener('submit', event => {
    if (!validatedInvite || validatedInvite !== invite.value.trim()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      showInvite();
      status.textContent = 'Volvé a validar tu invitación.';
      return;
    }
    if ($('register-password').value !== $('register-confirm-password').value) {
      event.preventDefault();
      event.stopImmediatePropagation();
      status.textContent = 'Las contraseñas no coinciden.';
      $('register-confirm-password').focus();
    }
  }, true);

  loginLink.addEventListener('click', showLogin);
  $('back-to-invite')?.addEventListener('click', showInvite);
  $('back-to-invite-login')?.addEventListener('click', showInvite);
  $('show-register')?.addEventListener('click', showInvite);

  const query = new URLSearchParams(location.search);
  const inviteFromLink = query.get('invite');
  if (inviteFromLink) {
    invite.value = inviteFromLink;
    form.classList.add('hidden');
    gate.requestSubmit();
  } else if (query.get('login') === '1') {
    showLogin();
  } else {
    showInvite();
  }
})();
