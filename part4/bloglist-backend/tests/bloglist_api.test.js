const mongoose = require('mongoose')
const supertest = require('supertest')
const app = require ('../app')
const Blog = require('../models/blog')
const User = require('../models/user')
const helper = require('./test_helper')

const api = supertest(app)

const blogHasAUser = (blog) => {
  expect(blog.user).toEqual(expect.anything()) // not null nor undefined
  expect(blog.user).toEqual(expect.any(Object))
}

beforeEach(helper.initializeDb)

describe('Get blog list', () => {
  test('Blogs are returned as json', async () => {
    await api.get('/api/blogs')
      .expect(200)
      .expect('Content-Type', /application\/json/)
  })

  test('All blogs are returend', async () => {
    const response = await api.get('/api/blogs')
    expect(response.body).toHaveLength(helper.initialBlogs.length)
  })

  test('Blogs have an id', async () => {
    const response = await api.get('/api/blogs')
    const blogs = response.body
    blogs.forEach(b => expect(b.id).toBeDefined())
    blogs.forEach(b => expect(b._id).toBeUndefined())
  })

  test('Blogs have a user', async() => {
    const response = await api.get('/api/blogs')
    const blogs = response.body
    blogs.forEach(b => {
      blogHasAUser(b)
    })
  })
})

describe('Post a new blog', () => {
  const randomUser = () => User.findOne({})

  const postAsUser = (user, blog) => {
    const token = user.getJwtToken()
    const authorizationHeader = 'bearer ' + token
    return api.post('/api/blogs')
      .set('Authorization', authorizationHeader)
      .send(blog)
  }

  test('Cannot post without a JWT token', async () => {
    const response = await api.post('/api/blogs')
      .send(helper.newBlog)
      .expect(401)
      .expect('Content-Type', /application\/json/)
    const content = response.body
    expect(content.error).toEqual(expect.stringContaining('token'))
    const newBlogs = await Blog.find({})
    expect(newBlogs).toHaveLength(helper.initialBlogs.length)
  })

  test('Posted blog is returned correctly', async () => {
    const user = await randomUser()
    const response = await postAsUser(user, helper.newBlog)
      .expect(201)
      .expect('Content-Type', /application\/json/)
    const receivedBlog = response.body
    expect(receivedBlog).toMatchObject(helper.newBlog)
    expect(receivedBlog.user.username).toEqual(user.username)
  })

  test('Posted blog is updated to the db', async () => {
    const beforeBlogs = await helper.currentBlogs()
    const response = await postAsUser(await randomUser(), helper.newBlog)
    const newId = response.body.id

    const afterBlogs = await helper.currentBlogs()
    expect(afterBlogs.length).toBe(beforeBlogs.length + 1)
    const extraBlog = afterBlogs.find(o => o.id === newId)
    expect(extraBlog).toMatchObject(helper.newBlog)
  })

  test('Posted blog in the db is linked to the user', async () => {
    const user = await randomUser()
    const response = await postAsUser(user, helper.newBlog)
    const newId = response.body.id

    const blogInDb = await Blog.findById(newId)
    expect(blogInDb.user).toEqual(user._id)
    const userInDb = await User.findById(user.id)
    expect(userInDb.blogs).toContainEqual(blogInDb._id)
  })

  test('If new blog has no likes, it defaults to 0', async () => {
    const blog = { ...helper.newBlog }
    delete blog.likes
    const response = await postAsUser(await randomUser(), blog)
      .expect(201) // created succesffuly
    expect(response.body.likes).toBe(0)

    const { likes: likesInDb } = await Blog.findById(response.body.id).select('likes').lean()
    expect(likesInDb).toBe(0)
  })

  test('Do not accept blogs without title and url', async () => {
    const oldBlogs = await helper.currentBlogs()
    const newBlog = {
      author: 'author'
    }
    await postAsUser(await randomUser(), newBlog)
      .expect(400)
    const newBlogs = await helper.currentBlogs()
    expect(newBlogs).toEqual(oldBlogs)
  })
})

describe('Deleting a blog', () => {
  const deleteAsUser = (user, id) => {
    const token = user.getJwtToken()
    return api.delete(`/api/blogs/${id}`)
      .set('Authorization', 'bearer ' + token)
  }

  test('Always 401 if not authenticated', async () => {
    const randomBlog = await Blog.findOne({})
    const id = randomBlog.id
    const response = await api.delete(`/api/blogs/${id}`)
      .expect(401)
      .expect('Content-Type', /application\/json/)

    expect(response.body.error).toEqual(expect.stringContaining('token'))

    const updatedBlogs = await Blog.find({})
    expect(updatedBlogs).toHaveLength(helper.initialBlogs.length)
  })

  test('Return 401 if not authenticated even for nonexistent blogs', async () => {
    const user = await User.findOne({}).select('_id').lean()
    const badId = await helper.nonexistentBlogId(user)
    const response = await api.delete(`/api/blogs/${badId}`)
      .expect(401)
      .expect('Content-Type', /application\/json/)

    expect(response.body.error).toEqual(expect.stringContaining('token'))

    const updatedBlogs = await Blog.find({})
    expect(updatedBlogs).toHaveLength(helper.initialBlogs.length)
  })

  test('You cannot delete a blog you don\'t own', async () => {
    const { _id: blogId } = await Blog.findOne({}, 'id', { lean: true })
    const newUser = await User.create(helper.newUser)
    await deleteAsUser(newUser, blogId)
      .expect(403)
    expect(await Blog.exists({ _id: blogId })).toBeTruthy()
  })

  test('Blog is deleted from db', async () => {
    const randomBlog = await Blog.findOne({})
    const user = await User.findById(randomBlog.user)
    await deleteAsUser(user, randomBlog.id)

    const deletedBlog = await Blog.findById(randomBlog.id)
    expect(deletedBlog).toBeNull()
  })

  test('HTTP response is 204', async() => {
    const randomBlog = await Blog.findOne({})
    const user = await User.findById(randomBlog.user)
    await deleteAsUser(user, randomBlog.id)
      .expect(204)
  })

  test('404 if a nonexistent blog is deleted', async () => {
    const user = await User.findOne({})
    const id = await helper.nonexistentBlogId(user)
    await deleteAsUser(user, id)
      .expect(404)
  })
})

describe('Updating a blog', () => {
  describe('PATCH behaves correctly', () => {
    const patchAsUser = (user, blogId, payload) => {
      let token = user.getJwtToken()
      return api.patch(`/api/blogs/${blogId}`)
        .set('Authorization', 'bearer ' + token)
        .send(payload)
    }

    test('returns 401 if not authenticated', async () => {
      const blog = await Blog.findOne({}).select('_id title').lean()
      const { _id: blogId, title } = blog
      const response = await api.patch(`/api/blogs/${blogId}`)
        .send(helper.newBlog)
        .expect(401)
        .expect('Content-Type', /application\/json/)

      expect(response.body.error).toEqual(expect.stringContaining('token'))

      const { title: titleInDb } = await Blog.findById(blogId).select('title').lean()
      expect(titleInDb).toBe(title)
    })

    test('returns 401 if not authenticated even if the blog does not exist', async () => {
      const randomUser = User.findOne({}).select('_id').lean()
      const blogId = await helper.nonexistentBlogId(randomUser)
      const response = await api.patch(`/api/blogs/${blogId}`)
        .send(helper.newBlog)
        .expect(401)
        .expect('Content-Type', /application\/json/)

      expect(response.body.error).toEqual(expect.stringContaining('token'))
    })

    test('You cannot patch a blog you don\'t own', async () => {
      const [ { _id: blogId, title }, newUser ] = await Promise.all( [
        Blog.findOne({}).select('_id title').lean(),
        User.create(helper.newUser)
      ])

      await patchAsUser(newUser, blogId, helper.newBlog)
        .expect(403)
        .expect('Content-Type', /application\/json/)
      const { title: titleInDb } = await Blog.findById(blogId).select('title').lean()
      expect(titleInDb).toBe(title)
    })

    test('returns the updated object in JSON format', async () => {
      const targetBlog = await Blog.findOne({}).lean()
      const user = await User.findById(targetBlog.user)
      const newBlog = { ...helper.newBlog }
      // Do not update url
      // we don't update every attribute in order to test
      // whether PATCH still returnes the attributes we omitted
      delete newBlog.url
      const response = await patchAsUser(user, targetBlog._id, newBlog)
        .expect(200)
        .expect('Content-Type', /application\/json/)

      const content = response.body
      expect(content).toMatchObject(newBlog)
      expect(content.url).toBe(targetBlog.url)
    })

    test('returns the existing object if nothing is updated', async () => {
      const targetBlog = await Blog.findOne({}).select({ __v: false }).lean()
      const user = await User.findById(targetBlog.user)
      const response = await patchAsUser(user, targetBlog._id, {})
        .expect(200)
        .expect('Content-Type', /application\/json/)

      const returnedBlog = response.body
      targetBlog.id = targetBlog._id.toString()
      delete targetBlog._id

      // depopulate
      delete returnedBlog.user
      delete targetBlog.user
      expect(returnedBlog).toEqual(targetBlog)
    })

    test('updates the existing object in db', async () => {
      const targetBlog = await Blog.findOne({}).lean()
      const user = await User.findById(targetBlog.user)
      const newBlog = { ...helper.newBlog }
      // Do not update url
      // we don't update every attribute in order to test
      // whether PATCH still returnes the attributes we omitted
      delete newBlog.url
      await patchAsUser(user, targetBlog._id, newBlog)

      const newBlogInDb = await Blog.findById(targetBlog._id).lean()
      expect(newBlogInDb).toMatchObject(newBlog)
    })

    test('returns 404 if the object is not found', async() => {
      const user = await User.findOne({})
      const id = await helper.nonexistentBlogId(user._id)
      await patchAsUser(user, id, {})
        .expect(404)
    })

    test('disallow changing the owner', async () => {
      const { _id: blogId, user: userId } =
        await Blog.findOne({}).select('_id user').lean()
      const user = await User.findById(userId)
      const newUser = await User.create(helper.newUser)
      await patchAsUser(user, blogId, { user: newUser.id })
        .expect(400)
        .expect('Content-Type', /application\/json/)
    })

  })

  describe('PUT behaves correctly', () => {
    const putAsUser = (user, blogId, payload) => {
      const token = user.getJwtToken()
      return api.put(`/api/blogs/${blogId}`)
        .set('Authorization', 'bearer ' + token)
        .send(payload)
    }

    test('returns 401 if not authenticated, do not modify db', async () => {
      const blog = await Blog.findOne({}).lean()
      const response = await api.put(`/api/blogs/${blog._id}`)
        .send(helper.newBlog)
        .expect(401)
        .expect('Content-Type', /application\/json/)

      expect(response.body.error).toEqual(expect.stringContaining('token'))

      const blogInDb = await Blog.findById(blog._id).lean()
      expect(blogInDb).toEqual(blog)
    })

    test('returns 401 if not authenticated, even when the blog does not exist', async () => {
      const id = await helper.nonexistentBlogId( await User.find({}).select('_id').lean() )

      const response = await api.put(`/api/blogs/${id}`)
        .send(helper.newBlog)
        .expect(401)
        .expect('Content-Type', /application\/json/)

      expect(response.body.error).toEqual(expect.stringContaining('token'))
    })

    test('You can\'t modify blogs of other users', async () => {
      const [ blog, anotherUser ] = await Promise.all([
        Blog.findOne({}).lean(),
        User.create(helper.newUser)
      ])
      await putAsUser(anotherUser, blog._id, helper.newBlog)
        .expect(403)
        .expect('Content-Type', /application\/json/)

      const blogInDb = await Blog.findById(blog._id).lean()
      expect(blogInDb).toEqual(blog)
    })

    test('returns the updated object in json', async () => {
      const { _id: blogId, user: userId } = await Blog.findOne({}).select('_id user').lean()
      const user = await User.findById(userId)
      const response = await putAsUser(user, blogId, helper.newBlog)
        .expect(200)
        .expect('Content-Type', /application\/json/)

      const updatedBlog = response.body
      expect(updatedBlog).toMatchObject(helper.newBlog)
    })

    test('updates the existing object in the db', async () => {
      const { _id: blogId, user: userId } = await Blog.findOne({}).select('_id user').lean()
      const user = await User.findById(userId)
      await putAsUser(user, blogId, helper.newBlog)

      const updatedBlog = await Blog.findById(blogId).lean()
      expect(updatedBlog).toMatchObject(helper.newBlog)
    })

    test('accepts blogs without a like, defaulting to zero', async () => {
      const { _id: blogId, user: userId } = await Blog.findOne({}).select('_id user').lean()
      const user = await User.findById(userId)
      const newBlog = { ... helper.newBlog }
      delete newBlog.likes
      const expectedBlog = { ...newBlog, likes: 0 }
      const response = await putAsUser(user, blogId, newBlog)
        .expect(200)
        .expect('Content-Type', /application\/json/)
      expect(response.body).toMatchObject(expectedBlog)
      const blogInDB = await Blog.findById(blogId).lean()
      expect(blogInDB).toMatchObject(expectedBlog)
    })

    test('Do not accept illegal blogs', async () => {
      const randomBlog = await Blog.findOne({}).lean()
      const user = await User.findById(randomBlog.user)
      const badBlog = { title: 'badtitle' }
      await putAsUser(user, randomBlog.id, badBlog)

      const blogInDb = await Blog.findById(randomBlog._id).lean()
      expect(blogInDb).toEqual(randomBlog)
    })

    test('returns 404 if no object is found', async () => {
      const user = await User.findOne({})
      const blogId = await helper.nonexistentBlogId(user)
      await putAsUser(user, blogId, helper.newBlog)
        .expect(404)
    })

    test('it\'s okay to put a user with your own userId', async () => {
      const { _id: blogId, user: userId } = await Blog.findOne({}).select('_id user').lean()
      const user = await User.findById(userId)
      const response = await putAsUser(user, blogId, { ...helper.newBlog })
        .expect(200)
        .expect('Content-Type', /application\/json/)

      expect(response.body).toMatchObject(helper.newBlog)
      const blogInDb = await Blog.findById(blogId).lean()
      expect(blogInDb).toMatchObject(helper.newBlog)
      expect(blogInDb.user).toEqual(user._id)
    })

    test('Do not modify the user of the blog', async () => {
      const blogAndUser = async () => {
        const blog = await Blog.findOne({}).lean()
        const user = await User.findById(blog.user)
        return { blog, user }
      }
      const [ { blog, user }, newUser ] = await Promise.all([
        blogAndUser(), User.create(helper.newUser)
      ])

      await putAsUser(user, blog._id, { ...blog, user: newUser.id })
        .expect(400)
        .expect('Content-Type', /application\/json/)

      const blogInDb = await Blog.findById(blog._id).lean()
      expect(blogInDb).toEqual(blog)
    })
  })
})

afterAll(() => mongoose.connection.close())
