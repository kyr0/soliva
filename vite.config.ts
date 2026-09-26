import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// import the defuss plugin - JSX for the UI components (resource bar, menu, ...)
import defuss from 'defuss-vite';
import { glbToObj } from './tools/models/glb.mjs';

/**
 * `import house from '../models/house.glb?model'` - das Modell als { obj, mtl }-Text
 * (tools/models/glb.mjs). Die Zeile `mtllib house.mtl` im OBJ nennt die Datei (Galerie).
 */
function glbModels(): Plugin {
  const suffix = '.glb?model';
  return {
    name: 'glb-model',
    enforce: 'pre',
    load(id) {
      if (!id.endsWith(suffix)) return null;
      const file = id.slice(0, -'?model'.length);
      this.addWatchFile(file);
      return `export default ${JSON.stringify(glbToObj(readFileSync(file), `${basename(file, '.glb')}.mtl`))};`;
    },
  };
}

/**
 * Nur mit `npm run dev` und der Adresse mit ?saveBillboards: nimmt die
 * Baumbilder entgegen, die das Spiel rendert (EntityRenderer.saveBillboard),
 * und legt sie als PNG in tools/export/out/billboards/ ab - zum Ansehen.
 */
function saveBillboards(): Plugin {
  const dir = join(import.meta.dirname, 'tools/export/out/billboards');
  rmSync(dir, { recursive: true, force: true })
  return {
    name: 'save-billboards',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__billboards', (req, res) => {
        const name = basename(decodeURIComponent(req.url ?? ''));
        if (req.method !== 'POST' || !/^[\w.-]+\.png$/.test(name)) {
          res.statusCode = 400; 
          res.end(); 
          return;  
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          mkdirSync(dir, { recursive: true });

          writeFileSync(join(dir, name), Buffer.concat(chunks));
          console.log(`billboards saved ${relative(import.meta.dirname,join(dir, name))}`)
          res.end('ok');
        });
      });
    },
  };
}

export default defineConfig({
  // add the defuss() plugin to make JSX transpilation work
  plugins: [glbModels(), saveBillboards(), defuss()],
  // Skelett-Clips aus Blender (src/models/*.glb) werden mit ?inline eingebettet.
  assetsInclude: ['**/*.glb'],
  build: {
    // Neben dem Spiel auch das L-System-Werkzeug (tools/lsystem/) und seine Galerie.
    rollupOptions: {
      input: {
        main: 'index.html',
        lsystem: 'tools/lsystem/index.html',
        lsystemGallery: 'tools/lsystem/gallery.html',
      },
    },
  },
});
