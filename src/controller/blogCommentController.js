// src/controller/blogCommentController.js
const BlogComment = require('../models/blogCommentModel');
const Blog = require('../models/blogModel');

// Create a new comment
exports.createComment = async (req, res) => {
  try {
    const { blogId, content, parentId } = req.body;
    const userId = req.user.id; // JWT payload uses 'id' not '_id'

    // Verify blog exists
    const blog = await Blog.findById(blogId);
    if (!blog) {
      return res.status(404).json({
        success: false,
        message: 'Blog not found'
      });
    }

    // If it's a reply, verify parent comment exists
    if (parentId) {
      const parentComment = await BlogComment.findById(parentId);
      if (!parentComment) {
        return res.status(404).json({
          success: false,
          message: 'Parent comment not found'
        });
      }
    }

    const comment = await BlogComment.create({
      blogId,
      userId,
      content,
      parentId: parentId || null
    });

    // Populate user data (User model has firstName, lastName, not 'name')
    await comment.populate('userId', 'firstName lastName email avatarUrl');

    // Transform the response to include a combined name
    const commentObj = comment.toObject();
    if (commentObj.userId) {
      commentObj.userId.name = `${commentObj.userId.firstName || ''} ${commentObj.userId.lastName || ''}`.trim();
      commentObj.userId.avatar = commentObj.userId.avatarUrl;
    }

    res.status(201).json({
      success: true,
      message: 'Comment posted successfully',
      data: commentObj
    });
  } catch (error) {
    console.error('Error creating comment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to post comment',
      error: error.message
    });
  }
};

// Helper function to transform user data
const transformUserData = (doc) => {
  const obj = doc.toObject ? doc.toObject() : doc;
  if (obj.userId) {
    obj.userId.name = `${obj.userId.firstName || ''} ${obj.userId.lastName || ''}`.trim();
    obj.userId.avatar = obj.userId.avatarUrl;
  }
  return obj;
};

// Get comments for a blog
exports.getBlogComments = async (req, res) => {
  try {
    const { blogId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    // Get parent comments (not replies)
    const comments = await BlogComment.find({
      blogId,
      parentId: null,
      status: 'active'
    })
      .populate('userId', 'firstName lastName email avatarUrl')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    // Get replies for each parent comment
    const commentsWithReplies = await Promise.all(
      comments.map(async (comment) => {
        const replies = await BlogComment.find({
          parentId: comment._id,
          status: 'active'
        })
          .populate('userId', 'firstName lastName email avatarUrl')
          .sort({ createdAt: 1 });

        const transformedComment = transformUserData(comment);
        transformedComment.replies = replies.map(transformUserData);

        return transformedComment;
      })
    );

    // Get total count
    const totalComments = await BlogComment.countDocuments({
      blogId,
      status: 'active'
    });

    res.status(200).json({
      success: true,
      data: commentsWithReplies,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalComments / limit),
        totalComments,
        hasMore: page * limit < totalComments
      }
    });
  } catch (error) {
    console.error('Error fetching comments:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch comments',
      error: error.message
    });
  }
};

// Update a comment
exports.updateComment = async (req, res) => {
  try {
    const { commentId } = req.params;
    const { content } = req.body;
    const userId = req.user.id;

    const comment = await BlogComment.findById(commentId);

    if (!comment) {
      return res.status(404).json({
        success: false,
        message: 'Comment not found'
      });
    }

    // Check if user owns the comment
    if (comment.userId.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You can only edit your own comments'
      });
    }

    comment.content = content;
    comment.isEdited = true;
    await comment.save();

    await comment.populate('userId', 'firstName lastName email avatarUrl');

    res.status(200).json({
      success: true,
      message: 'Comment updated successfully',
      data: transformUserData(comment)
    });
  } catch (error) {
    console.error('Error updating comment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update comment',
      error: error.message
    });
  }
};

// Delete a comment
exports.deleteComment = async (req, res) => {
  try {
    const { commentId } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const comment = await BlogComment.findById(commentId);

    if (!comment) {
      return res.status(404).json({
        success: false,
        message: 'Comment not found'
      });
    }

    // Check if user owns the comment or is admin
    if (comment.userId.toString() !== userId.toString() && userRole !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'You can only delete your own comments'
      });
    }

    // Soft delete - mark as deleted
    comment.status = 'deleted';
    await comment.save();

    // Also soft delete all replies
    await BlogComment.updateMany(
      { parentId: commentId },
      { status: 'deleted' }
    );

    res.status(200).json({
      success: true,
      message: 'Comment deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting comment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete comment',
      error: error.message
    });
  }
};

// Like/Unlike a comment
exports.toggleLike = async (req, res) => {
  try {
    const { commentId } = req.params;
    const userId = req.user.id;

    const comment = await BlogComment.findById(commentId);

    if (!comment) {
      return res.status(404).json({
        success: false,
        message: 'Comment not found'
      });
    }

    // Convert to string for comparison
    const likeIndex = comment.likes.findIndex(id => id.toString() === userId.toString());

    if (likeIndex > -1) {
      // Unlike
      comment.likes.splice(likeIndex, 1);
    } else {
      // Like
      comment.likes.push(userId);
    }

    await comment.save();

    res.status(200).json({
      success: true,
      message: likeIndex > -1 ? 'Comment unliked' : 'Comment liked',
      data: {
        likesCount: comment.likes.length,
        isLiked: likeIndex === -1
      }
    });
  } catch (error) {
    console.error('Error toggling like:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to toggle like',
      error: error.message
    });
  }
};

// Get comment count for a blog
exports.getCommentCount = async (req, res) => {
  try {
    const { blogId } = req.params;

    const count = await BlogComment.countDocuments({
      blogId,
      status: 'active'
    });

    res.status(200).json({
      success: true,
      data: { count }
    });
  } catch (error) {
    console.error('Error getting comment count:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get comment count',
      error: error.message
    });
  }
};
