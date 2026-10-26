// Minimal SPARQL endpoint which echoes what the template sent it, so the test
// can verify the query and the forwarded mu headers.
//
// A query containing `# respond:500` or `# respond:text` makes the endpoint
// fail with a server error or answer with something which isn't JSON.
import http from 'node:http';

http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => body += chunk);
  req.on('end', () => {
    const query = new URLSearchParams(body).get('query') || '';
    if (query.includes('# respond:500')) {
      res.statusCode = 500;
      res.end('Internal error');
      return;
    }
    if (query.includes('# respond:text')) {
      res.setHeader('content-type', 'text/plain');
      res.end('this is not json');
      return;
    }

    const muHeaders = Object.fromEntries(
      Object.entries(req.headers).filter(([key]) => key.startsWith('mu-'))
    );
    const literal = (value) => ({ type: 'literal', value: value || '' });
    res.setHeader('content-type', 'application/sparql-results+json');
    res.setHeader('mu-auth-allowed-groups', '[{"name":"from-database"}]');
    res.setHeader('mu-auth-used-groups', '[{"name":"used-by-database"}]');
    res.end(JSON.stringify({
      head: { vars: ['query', 'session', 'headers'] },
      results: {
        bindings: [{
          query: literal(query),
          session: literal(req.headers['mu-session-id']),
          headers: literal(JSON.stringify(muHeaders))
        }]
      }
    }));
  });
}).listen(8890);
