// Pointer-tracked tilt + holo for the landing card grid.
// Each card tilts away from the cursor edge (the poke-holo push-back) and
// the holo/glare layers follow the pointer via CSS variables.
(function () {
  function wire(card) {
    card.setAttribute("data-live", "1");
    var rect = null;
    card.addEventListener("pointerenter", function () {
      rect = card.getBoundingClientRect();
    });
    card.addEventListener("pointermove", function (e) {
      if (!rect) rect = card.getBoundingClientRect();
      var px = (e.clientX - rect.left) / rect.width;   // 0..1
      var py = (e.clientY - rect.top) / rect.height;
      var ry = (px - 0.5) * -24; // cursor right -> right edge pushes back
      var rx = (py - 0.5) * 18;  // cursor top -> top edge pushes back
      card.style.setProperty("--rx", rx.toFixed(2) + "deg");
      card.style.setProperty("--ry", ry.toFixed(2) + "deg");
      card.style.setProperty("--mx", (px * 100).toFixed(1) + "%");
      card.style.setProperty("--my", (py * 100).toFixed(1) + "%");
      card.style.setProperty("--o", "1");
    });
    card.addEventListener("pointerleave", function () {
      rect = null;
      card.style.setProperty("--rx", "0deg");
      card.style.setProperty("--ry", "0deg");
      card.style.setProperty("--o", "0");
    });
  }
  function init() {
    document.querySelectorAll(".fl-card").forEach(function (card) {
      if (!card.hasAttribute("data-live")) wire(card);
    });
  }
  init();
  // Mintlify is a SPA; re-wire on client-side navigation and rerenders.
  new MutationObserver(init).observe(document.body, {
    childList: true,
    subtree: true,
  });
})();
