import mu, { app, beforeExit, errorHandler, query, sparqlEscapeString, uuid } from 'mu';
import ms from 'ms';
import { nanoid } from 'nanoid';
import settings from './config/settings';
import data from './config/data.json';
import deep from './config/nested/deep';
import typed from './config/typed';
import { greet } from './lib/greeting';
import { shout } from './lib/shout';

// only provided through a mounted /config
const extra = await import('./config/extra.js').catch(() => null);

app.get('/status', function (req, res) {
  res.send({
    node: process.version,
    uuid: uuid(),
    defaultImport: typeof mu.query,
    dependency: ms('2h'),
    esmDependency: nanoid().length,
    config: settings.greeting,
    jsonConfig: data.source,
    nestedConfig: deep.value,
    typescriptConfig: typed.value,
    extraConfig: extra?.default.value ?? null,
    typescript: greet('template'),
    coffeescript: shout('template'),
    escaped: sparqlEscapeString('say "hi"')
  });
});

// ?sudo=true and ?scope=... are passed as query options, ?respond=... makes
// the mock SPARQL endpoint misbehave
app.get('/sparql', async function (req, res) {
  const options = {};
  if (req.query.sudo) options.sudo = true;
  if (req.query.scope) options.scope = req.query.scope;
  const marker = req.query.respond ? `# respond:${req.query.respond}\n` : '';
  try {
    const result = await query(`${marker}SELECT * WHERE { ?s ?p ${sparqlEscapeString('o')} }`, options);
    res.send({ result });
  } catch (e) {
    res.status(500).send({ error: e.message });
  }
});

beforeExit(async () => {
  console.log('beforeExit callback ran');
});

app.use(errorHandler);
