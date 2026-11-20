# Dager Habit

## Identidad

Dager Habit es una herramienta personal de estudio. La biblioteca toma la jerarquía de un catálogo editorial. Una fotografía presenta la pantalla, las filas muestran los títulos y el formulario aparece junto a la colección. El símbolo de libro abierto se usa en el encabezado y en el ícono de la PWA.

| Rol | Color |
| --- | --- |
| Fondo papel | #F7F5EF |
| Superficies | #FFFCF5 |
| Tinta | #202C25 |
| Texto secundario | #535E53 |
| Verde de marca y acción principal | #19382C |
| Verde oscuro de la cabecera | #11271F |
| Crema sobre verde | #FFF3DB |
| Ocre del símbolo | #F1BD83 |
| Ocre oscuro del foco | #855020 |
| Error | #A0342A |

Fraunces Variable se usa en títulos. DM Sans Variable se usa en lectura, formularios y estados. Ambas se empaquetan con la app. Los colores y las familias se definen como variables CSS.

## Interfaz

- Una acción principal por vista. En la biblioteca, el formulario queda a la derecha en escritorio y debajo de la colección en pantallas angostas. «Agregar libro» lleva directo al formulario.
- Conservá el voseo. Los campos tienen etiquetas visibles. Mostrá el resultado de cada guardado.
- Usá controles nativos con foco visible y objetivos táctiles de al menos 44 px. La colección admite títulos largos y zoom del navegador.
- Empaquetá los recursos visuales con la PWA. La fotografía de portada es decorativa y la biblioteca usa IndexedDB.

## Fotografía de portada

La imagen `public/reading-desk.jpg` se generó con ImageGen y se exportó como JPEG de 960 px de ancho. Prompt original:

> Photorealistic editorial still life for the Dager Habit study library. Close side view of a small stack of worn, unlettered olive and russet clothbound books with an open book draped on top, cream pages fanning slightly, one narrow muted orange fabric bookmark, on a deep forest-green table and matching dark forest-green seamless backdrop. Warm raking late afternoon window light from upper right, soft directional shadows, fine analog grain, elegant independent bookshop art direction, rendered as a genuine studio photograph. Landscape 3:2. Arrange entire interesting book arrangement in the right two-thirds of the image, middle height. Left third fades into deep green shadow. No typography, no legible text, no logos, no people, no interface, no graphic frames.

## Referencias

[Taste Skill](https://www.tasteskill.dev/) · [Vercel Web Interface Guidelines](https://vercel.com/design/guidelines) · [awesome-design-md](https://github.com/voltagent/awesome-design-md) · [Modern Web Guidance](https://developer.chrome.com/docs/modern-web-guidance) · [Playwright CLI](https://playwright.dev/agent-cli/introduction)
