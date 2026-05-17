(function () {
  const params = new URLSearchParams(window.location.search);
  const refToken = params.get('ref') || '';

  const groups = [
    { key: 'preferred_drinks', title: 'Drink Preference', options: ['Vodka', 'Cognac', 'Whiskey', 'Scotch', 'Tequila'] },
    { key: 'preferred_party_types', title: 'Party Type', options: ['Lounge', 'Club', 'Day Party'] },
    { key: 'preferred_music', title: 'Music', options: ['Hip Hop', 'Afro Beats', 'R&B'] },
    { key: 'preferred_venue_types', title: 'Venue Type', options: ['Waterfront', 'Poolside', 'Rooftop', 'Yacht'] },
  ];

  const selected = Object.fromEntries(groups.map(group => [group.key, new Set()]));

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function ensureStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .preference-game{background:#121212;color:#fff;padding:72px 8%;border-top:1px solid rgba(197,160,89,.25);border-bottom:1px solid rgba(197,160,89,.25)}
      .preference-game-inner{max-width:1100px;margin:0 auto}
      .preference-game h2{color:#c5a059;text-transform:uppercase;letter-spacing:2px;font-size:clamp(1.7rem,4vw,2.6rem);margin-bottom:8px}
      .preference-game .game-sub{color:#b7b0a1;margin-bottom:28px}
      .game-board{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:18px;margin-bottom:28px}
      .game-group{border:1px solid rgba(197,160,89,.25);padding:18px;background:rgba(255,255,255,.035);border-radius:6px}
      .game-group h3{color:#c5a059;font-size:.9rem;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
      .tile-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
      .pref-tile{min-height:52px;border:1px solid rgba(197,160,89,.35);background:rgba(255,255,255,.04);color:#fff;border-radius:5px;cursor:pointer;font-weight:700}
      .pref-tile.active{background:#c5a059;color:#121212;border-color:#e2c285}
      .game-contact{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:16px}
      .game-contact input{width:100%;padding:12px;background:rgba(255,255,255,.06);border:1px solid rgba(197,160,89,.3);color:#fff;border-radius:4px}
      .game-actions{display:flex;align-items:center;gap:14px;margin-top:16px;flex-wrap:wrap}
      .game-actions button{padding:13px 24px;background:linear-gradient(45deg,#c5a059,#e2c285);border:0;color:#121212;font-weight:800;text-transform:uppercase;border-radius:4px;cursor:pointer}
      .game-status{color:#c5a059;min-height:22px}
      @media(max-width:760px){.game-contact{grid-template-columns:1fr}.tile-grid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function render() {
    ensureStyles();
    const section = document.createElement('section');
    section.className = 'preference-game';
    section.id = 'preference-game';
    section.innerHTML = `
      <div class="preference-game-inner">
        <h2>Build Your Night</h2>
        <p class="game-sub">Pick the tiles that match your style so Classic Productions can send better event invites.</p>
        <div class="game-board">
          ${groups.map(group => `
            <div class="game-group">
              <h3>${escapeHtml(group.title)}</h3>
              <div class="tile-grid">
                ${group.options.map(option => `<button type="button" class="pref-tile" data-group="${group.key}" data-value="${escapeHtml(option)}">${escapeHtml(option)}</button>`).join('')}
              </div>
            </div>`).join('')}
        </div>
        <form id="preference-game-form">
          <div class="game-contact">
            <input name="full_name" placeholder="Full name" required maxlength="150">
            <input name="email" type="email" placeholder="Email" required maxlength="200">
            <input name="phone" type="tel" placeholder="Mobile number" maxlength="30">
            <input name="social_handles" placeholder="@social handles" maxlength="250">
          </div>
          <div class="game-actions">
            <button type="submit">Save My Picks</button>
            <span class="game-status" id="preference-game-status"></span>
          </div>
        </form>
      </div>
    `;

    const anchor = document.getElementById('events') || document.querySelector('.container') || document.body.firstElementChild;
    if (anchor && anchor.parentNode && anchor.id === 'events') {
      anchor.parentNode.insertBefore(section, anchor.nextSibling);
    } else if (anchor && anchor.classList && anchor.classList.contains('container')) {
      anchor.insertBefore(section, anchor.firstElementChild);
    } else {
      document.body.appendChild(section);
    }

    section.querySelectorAll('.pref-tile').forEach(tile => {
      tile.addEventListener('click', () => {
        const group = tile.dataset.group;
        const value = tile.dataset.value;
        tile.classList.toggle('active');
        if (tile.classList.contains('active')) selected[group].add(value);
        else selected[group].delete(value);
      });
    });

    section.querySelector('#preference-game-form').addEventListener('submit', async event => {
      event.preventDefault();
      const status = document.getElementById('preference-game-status');
      const data = Object.fromEntries(new FormData(event.target));
      for (const group of groups) data[group.key] = [...selected[group.key]];
      data.ref = refToken;
      status.textContent = 'Saving...';
      try {
        const response = await fetch('/api/preference-game', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        const result = await response.json();
        status.textContent = response.ok && result.success
          ? 'Saved. Your invites just got smarter.'
          : (result.error || 'Could not save picks.');
      } catch (_) {
        status.textContent = 'Network error. Try again.';
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();
