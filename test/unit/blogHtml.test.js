// What a blog post may store: the article markup the website keeps, with
// script, event handlers, styling and script-carrying addresses removed; an
// excerpt of inline emphasis only; and structured data that is a JSON object,
// stored so it cannot close the <script> tag a page puts it in.
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanBlogHtml, cleanExcerpt, readMetaSchema, writeMetaSchema } = require('../../src/services/blogs/blogHtml');

test('an ordinary article is stored as written', () => {
  const article = [
    '<h1>Five ways to squat better</h1>',
    '<p class="lead">Start <strong>light</strong> and <em>slow</em>.</p>',
    '<figure><img src="https://store1.public.blob.vercel-storage.com/gym-a/blogs/images/squat.jpg" alt="A squat" /><figcaption>Depth first</figcaption></figure>',
    '<p><img src="/uploads/gym-a/rack.png" alt="Rack" /> <a href="/packages">Join</a> or <a href="mailto:hello@gym.test">write</a> to us, or jump <a href="#tips">down</a>.</p>',
    '<ul><li>Brace</li><li>Breathe</li></ul>',
    '<pre><code>5 x 5 &lt; 3 x 10</code></pre>',
    '<table><thead><tr><th colspan="2">Week</th></tr></thead><tbody><tr><td>1</td><td>60kg</td></tr></tbody></table>',
    '<blockquote>Slow is smooth.</blockquote><hr />'
  ].join('');
  assert.equal(cleanBlogHtml(article), article);
});

test('script, handlers, styling and script-carrying addresses are removed', () => {
  const cases = [
    ['<p>Hi</p><script>alert(1)</script>', '<p>Hi</p>'],
    ['<p onclick="alert(1)" style="position:fixed">Hi</p>', '<p>Hi</p>'],
    ['<img src="x.png" onerror="alert(1)" alt="a" />', '<img src="x.png" alt="a" />'],
    ['<a href="javascript:alert(1)">go</a>', '<a>go</a>'],
    ['<a href="JaVaScRiPt:alert(1)">go</a>', '<a>go</a>'],
    ['<img src="data:image/svg+xml;base64,PHN2Zz4=" alt="a" />', '<img alt="a" />'],
    ['<img src="//evil.test/x.png" alt="a" />', '<img alt="a" />'],
    ['<iframe src="https://evil.test"></iframe><p>Hi</p>', '<p>Hi</p>'],
    ['<style>body{display:none}</style><p>Hi</p>', '<p>Hi</p>'],
    ['<form action="https://evil.test"><input name="password" /></form><p>Hi</p>', '<p>Hi</p>'],
    ['<svg><animate onbegin="alert(1)" attributeName="x" /></svg><p>Hi</p>', '<p>Hi</p>'],
    ['<textarea></textarea/><img src=x onerror=alert(1)><p>Hi</p>', null],
    ['<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>', null]
  ];
  for (const [dirty, expected] of cases) {
    const cleaned = cleanBlogHtml(dirty);
    if (expected !== null) assert.equal(cleaned, expected, dirty);
    assert.doesNotMatch(cleaned, /<script|onerror|onclick|onbegin|javascript:|<iframe|<style|<form|<svg|<textarea/i, dirty);
  }
});

test('a link that opens a new tab cannot reach back into the page', () => {
  assert.equal(
    cleanBlogHtml('<a href="https://example.test" target="_blank">out</a>'),
    '<a href="https://example.test" target="_blank" rel="noopener noreferrer">out</a>'
  );
});

test('a body with nothing left, or none at all, is empty', () => {
  assert.equal(cleanBlogHtml('<script>alert(1)</script>'), '');
  assert.equal(cleanBlogHtml('   '), '');
  assert.equal(cleanBlogHtml(undefined), '');
  assert.equal(cleanBlogHtml(null), '');
});

test('an excerpt keeps inline emphasis only', () => {
  assert.equal(cleanExcerpt('  <strong>New</strong> <h2>class</h2><img src=x onerror=alert(1)> times  '), '<strong>New</strong> class times');
  assert.equal(cleanExcerpt('<span class="x" onclick="a()">hi</span>'), '<span>hi</span>');
  assert.equal(cleanExcerpt('x'.repeat(600)).length, 500);
  assert.equal(cleanExcerpt(undefined), '');
  assert.equal(cleanExcerpt({ html: '<b>x</b>' }), '');
});

test('structured data must be a JSON object with @context and @type', () => {
  const schema = { '@context': 'https://schema.org', '@type': 'BlogPosting', headline: 'Squat' };
  assert.deepEqual(JSON.parse(readMetaSchema(JSON.stringify(schema))), schema);
  assert.deepEqual(JSON.parse(readMetaSchema(schema)), schema, 'an object is taken as it is');

  for (const bad of ['not json', '{"@context": "https://schema.org"', '[]', '"text"', '42', 'null', '{"@type":"BlogPosting"}', '{"@context":"https://schema.org"}']) {
    assert.throws(() => readMetaSchema(bad), /^Error: Invalid JSON-LD schema: /, bad);
  }
});

test('stored structured data cannot close the script tag it is put in', () => {
  const stored = readMetaSchema(JSON.stringify({ '@context': 'https://schema.org', '@type': 'BlogPosting', headline: '</script><script>alert(1)</script>' }));
  assert.doesNotMatch(stored, /</);
  assert.equal(JSON.parse(stored).headline, '</script><script>alert(1)</script>', 'and still reads back as what was typed');
  assert.doesNotMatch(writeMetaSchema({ a: '<!--' }), /</);
});
