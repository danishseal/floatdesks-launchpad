# Portable Pokemon holographic card

Copy `pokemon-card.js` and `pokemon-card.css` into any site.

The `images/` folder contains demo assets. You can test immediately with:

```html
<link rel="stylesheet" href="/pokemon-card.css" />
<script type="module" src="/pokemon-card.js"></script>

<pokemon-card
  image="/pokemon-card/images/demo-front.png"
  name="Demo card"
  back="/pokemon-card/images/demo-back.jpg"
  foil="/pokemon-card/images/demo-foil.jpg">
</pokemon-card>
```

`image` is the front face and `back` is the back face. A normal click opens the card; double-click it to flip between front and back.

In Next.js, place the files in `public/pokemon-card/`, then add the stylesheet in `app/layout.tsx` or `app/globals.css`, and load the script from a client component:

```jsx
'use client';
import { useEffect } from 'react';
import '/pokemon-card/pokemon-card.css';

export default function Card({ image, name }) {
  useEffect(() => { import('/pokemon-card/pokemon-card.js'); }, []);
  return <pokemon-card image={image} name={name} />;
}
```
