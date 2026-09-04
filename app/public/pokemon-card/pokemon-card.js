/**
 * Portable Pokemon-style holographic card.
 * Usage: import './pokemon-card.js';
 * <pokemon-card image="/cards/pikachu.png" name="Pikachu"></pokemon-card>
 */
class PokemonCard extends HTMLElement {
  connectedCallback() {
    if (this._ready) return;
    this._ready = true;
    this.innerHTML = `
      <div class="pcard-shell">
        <button class="pcard-tilt" type="button" aria-label="Open card">
          <img class="pcard-back" alt="" />
          <div class="pcard-front">
            <img class="pcard-image" />
            <div class="pcard-shine"></div><div class="pcard-glare"></div>
          </div>
        </button>
      </div>`;
    this._tilt = this.querySelector('.pcard-tilt');
    this._front = this.querySelector('.pcard-image');
    this._back = this.querySelector('.pcard-back');
    this._front.src = this.getAttribute('image') || '';
    this._front.alt = this.getAttribute('name') || 'Pokemon card';
    this._back.src = this.getAttribute('back') || '';
    const foil = this.getAttribute('foil');
    if (foil) this.style.setProperty('--pcard-foil', `url("${foil}")`);

    this._move = (event) => {
      const point = event.touches ? event.touches[0] : event;
      const r = this._tilt.getBoundingClientRect();
      const x = Math.max(0, Math.min(100, ((point.clientX - r.left) / r.width) * 100));
      const y = Math.max(0, Math.min(100, ((point.clientY - r.top) / r.height) * 100));
      this.style.setProperty('--pcard-x', `${x}%`);
      this.style.setProperty('--pcard-y', `${y}%`);
      this.style.setProperty('--pcard-rx', `${(50 - y) / 3.5}deg`);
      this.style.setProperty('--pcard-ry', `${(x - 50) / 3.5}deg`);
      this.classList.add('is-interacting');
    };
    this._reset = () => {
      this.classList.remove('is-interacting');
      this.style.setProperty('--pcard-rx', '0deg'); this.style.setProperty('--pcard-ry', '0deg');
      this.style.setProperty('--pcard-x', '50%'); this.style.setProperty('--pcard-y', '50%');
    };
    this._tilt.addEventListener('pointermove', this._move);
    this._tilt.addEventListener('pointerleave', this._reset);
    this._tilt.addEventListener('click', () => this.classList.toggle('is-open'));
    this._tilt.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (this._back.src) this.classList.toggle('is-flipped');
    });
    document.addEventListener('pointerdown', (e) => { if (this.classList.contains('is-open') && !this.contains(e.target)) this.classList.remove('is-open'); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.classList.remove('is-open'); });
  }
}
customElements.define('pokemon-card', PokemonCard);
