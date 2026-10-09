// Saving a blog post, against a real MongoDB: the body and excerpt are
// stored without script whichever route wrote them, a body with nothing left
// is refused, and the structured data must be JSON and is stored so it
// cannot break out of the page that embeds it.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let Blog;
let blogs;
let categoryId;

const test = h.suite(async () => {
  Blog = h.src('models/blogModel');
  blogs = h.src('controller/blogController');
  const BlogCategory = h.src('models/BlogCategory');

  gym = await h.createGym('blog-sanitise-gym');
  await h.inGym(gym, async () => {
    await h.ensureIndexes(Blog, BlogCategory);
    categoryId = String((await BlogCategory.create({ name: 'Training', slug: 'training' }))._id);
  });
});

const author = { user: { _id: '0000000000000000000000aa' } };
const create = (body) => h.inGym(gym, () => h.call(blogs.createBlog, { ...author, body: { categoryId, ...body }, files: {} }));
const update = (id, body) => h.inGym(gym, () => h.call(blogs.updateBlog, { ...author, params: { id }, body, files: {} }));
const stored = (id) => h.inGym(gym, () => Blog.findById(id).lean());

const UNSAFE = /<script|onerror|onclick|javascript:|<iframe/i;

test('a new post is stored without the script it was sent with', async () => {
  const res = await create({
    title: 'Squat better',
    content: '<h2>Start light</h2><p onclick="steal()">Brace <strong>first</strong>.</p><script>steal()</script><img src="/uploads/x.png" onerror="steal()" alt="Rack" />',
    excerpt: '<strong>Squat</strong><script>steal()</script> better'
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));

  const blog = await stored(res.body.data._id);
  assert.equal(blog.content, '<h2>Start light</h2><p>Brace <strong>first</strong>.</p><img src="/uploads/x.png" alt="Rack" />');
  assert.equal(blog.excerpt, '<strong>Squat</strong> better');
  assert.equal(blog.metaDescription, 'Start lightBrace first.');
  // The structured data it was given by default is JSON, and safe to embed.
  assert.equal(JSON.parse(blog.metaSchema)['@type'], 'BlogPosting');
  assert.doesNotMatch(blog.metaSchema, /</);
});

test('a post whose body is nothing but script is refused', async () => {
  const res = await create({ title: 'Empty', content: '<script>steal()</script>' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /content.*required/i);
  assert.equal(await h.inGym(gym, () => Blog.exists({ title: 'Empty' })), null);
});

test('an edit is cleaned the same way, and cannot empty the post', async () => {
  const made = await create({ title: 'Deadlift basics', content: '<p>Hinge.</p>' });
  const id = String(made.body.data._id);

  const edited = await update(id, { content: '<p>Hinge at the hips.</p><iframe src="https://evil.test"></iframe><a href="javascript:steal()">more</a>', excerpt: '<em>Hinge</em><img src=x onerror=steal()>' });
  assert.equal(edited.statusCode, 200, JSON.stringify(edited.body));
  const blog = await stored(id);
  assert.equal(blog.content, '<p>Hinge at the hips.</p><a>more</a>');
  assert.equal(blog.excerpt, '<em>Hinge</em>');
  assert.doesNotMatch(JSON.stringify(blog), UNSAFE);

  const emptied = await update(id, { content: '<script>steal()</script>' });
  assert.equal(emptied.statusCode, 400);
  assert.equal((await stored(id)).content, '<p>Hinge at the hips.</p><a>more</a>', 'the post is as it was');

  // An edit that does not touch the body leaves it alone.
  const retitled = await update(id, { title: 'Deadlift: the basics' });
  assert.equal(retitled.statusCode, 200);
  assert.equal((await stored(id)).content, '<p>Hinge at the hips.</p><a>more</a>');
});

test('structured data must be JSON, and is stored so it cannot close a script tag', async () => {
  for (const bad of ['{not json', '"just text"', '[]', '{"@type":"BlogPosting"}']) {
    const res = await create({ title: `Bad schema ${bad.length}`, content: '<p>x</p>', metaSchema: bad });
    assert.equal(res.statusCode, 400, bad);
    assert.match(res.body.message, /Invalid JSON-LD schema/);
  }

  const schema = { '@context': 'https://schema.org', '@type': 'BlogPosting', headline: '</script><script>steal()</script>' };
  const made = await create({ title: 'Good schema', content: '<p>x</p>', metaSchema: JSON.stringify(schema) });
  assert.equal(made.statusCode, 201, JSON.stringify(made.body));
  const id = String(made.body.data._id);
  let blog = await stored(id);
  assert.doesNotMatch(blog.metaSchema, /</);
  assert.deepEqual(JSON.parse(blog.metaSchema), schema);

  const refused = await update(id, { metaSchema: '{broken' });
  assert.equal(refused.statusCode, 400);
  blog = await stored(id);
  assert.deepEqual(JSON.parse(blog.metaSchema), schema, 'a refused edit changes nothing');
});
