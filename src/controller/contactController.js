const Contact = require('../models/contactModel');

// Submit a new contact form
exports.submitContact = async (req, res) => {
  try {
    const { fullName, emailAddress, phoneNumber, subject, message, category = 'general' } = req.body;

    // Validation
    if (!fullName || !emailAddress || !message) {
      return res.status(400).json({
        success: false,
        message: 'Full name, email address, and message are required'
      });
    }

    // Create new contact submission
    const newContact = new Contact({
      fullName: fullName.trim(),
      emailAddress: emailAddress.toLowerCase().trim(),
      phoneNumber: phoneNumber?.trim(),
      subject: subject?.trim() || 'General Inquiry',
      message: message.trim(),
      category,
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get('User-Agent')
    });

    await newContact.save();

    // Send response without sensitive data
    return res.status(201).json({
      success: true,
      message: 'Your message has been submitted successfully! We will get back to you within 24-48 hours.',
      data: {
        id: newContact._id,
        fullName: newContact.fullName,
        emailAddress: newContact.emailAddress,
        subject: newContact.subject,
        submittedAt: newContact.createdAt
      }
    });

  } catch (error) {
    console.error('Error submitting contact form:', error);

    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validationErrors
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to submit contact form. Please try again.',
      error: error.message
    });
  }
};

// Get all contacts (Admin only)
exports.getAllContacts = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status = 'all',
      category = 'all',
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const skip = (page - 1) * limit;
    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Build query
    let query = {};
    if (status !== 'all') query.status = status;
    if (category !== 'all') query.category = category;

    const [contacts, total] = await Promise.all([
      Contact.find(query)
        .sort(sortOptions)
        .skip(skip)
        .limit(parseInt(limit))
        .populate('assignedTo', 'email firstName lastName')
        .select('-userAgent -ipAddress -adminNotes'),
      Contact.countDocuments(query)
    ]);

    return res.status(200).json({
      success: true,
      message: 'Contacts retrieved successfully',
      data: contacts,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit),
        limit: parseInt(limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1
      }
    });

  } catch (error) {
    console.error('Error getting contacts:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve contacts',
      error: error.message
    });
  }
};

// Get contact by ID (Admin only)
exports.getContactById = async (req, res) => {
  try {
    const { id } = req.params;

    const contact = await Contact.findById(id)
      .populate('assignedTo', 'email firstName lastName')
      .populate('adminNotes.addedBy', 'email firstName lastName');

    if (!contact) {
      return res.status(404).json({
        success: false,
        message: 'Contact not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Contact retrieved successfully',
      data: contact
    });

  } catch (error) {
    console.error('Error getting contact by ID:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve contact',
      error: error.message
    });
  }
};

// Update contact status (Admin only)
exports.updateContactStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['new', 'in_progress', 'resolved', 'closed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Valid statuses are: new, in_progress, resolved, closed'
      });
    }

    const contact = await Contact.findById(id);
    if (!contact) {
      return res.status(404).json({
        success: false,
        message: 'Contact not found'
      });
    }

    contact.status = status;
    await contact.save();

    return res.status(200).json({
      success: true,
      message: 'Contact status updated successfully',
      data: contact
    });

  } catch (error) {
    console.error('Error updating contact status:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update contact status',
      error: error.message
    });
  }
};

// Update contact priority (Admin only)
exports.updateContactPriority = async (req, res) => {
  try {
    const { id } = req.params;
    const { priority } = req.body;

    const validPriorities = ['low', 'medium', 'high', 'urgent'];
    if (!validPriorities.includes(priority)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid priority. Valid priorities are: low, medium, high, urgent'
      });
    }

    const contact = await Contact.findById(id);
    if (!contact) {
      return res.status(404).json({
        success: false,
        message: 'Contact not found'
      });
    }

    contact.priority = priority;
    await contact.save();

    return res.status(200).json({
      success: true,
      message: 'Contact priority updated successfully',
      data: contact
    });

  } catch (error) {
    console.error('Error updating contact priority:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update contact priority',
      error: error.message
    });
  }
};

// Add admin note to contact (Admin only)
exports.addAdminNote = async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;
    const adminId = req.user.id; // From auth middleware

    if (!note || note.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Note content is required'
      });
    }

    const contact = await Contact.findById(id);
    if (!contact) {
      return res.status(404).json({
        success: false,
        message: 'Contact not found'
      });
    }

    await contact.addAdminNote(note.trim(), adminId);

    const updatedContact = await Contact.findById(id)
      .populate('adminNotes.addedBy', 'email firstName lastName');

    return res.status(200).json({
      success: true,
      message: 'Admin note added successfully',
      data: updatedContact
    });

  } catch (error) {
    console.error('Error adding admin note:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to add admin note',
      error: error.message
    });
  }
};

// Assign contact to admin (Admin only)
exports.assignContact = async (req, res) => {
  try {
    const { id } = req.params;
    const { assignedTo } = req.body;

    const contact = await Contact.findById(id);
    if (!contact) {
      return res.status(404).json({
        success: false,
        message: 'Contact not found'
      });
    }

    contact.assignedTo = assignedTo || null;
    await contact.save();

    const updatedContact = await Contact.findById(id)
      .populate('assignedTo', 'email firstName lastName');

    return res.status(200).json({
      success: true,
      message: assignedTo ? 'Contact assigned successfully' : 'Contact unassigned successfully',
      data: updatedContact
    });

  } catch (error) {
    console.error('Error assigning contact:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to assign contact',
      error: error.message
    });
  }
};

// Get contact statistics (Admin only)
exports.getContactStats = async (req, res) => {
  try {
    const stats = await Contact.getContactStats();

    // Get recent contacts (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentContacts = await Contact.countDocuments({
      createdAt: { $gte: sevenDaysAgo }
    });

    // Get unread contacts
    const unreadContacts = await Contact.countDocuments({ status: 'new' });

    return res.status(200).json({
      success: true,
      message: 'Contact statistics retrieved successfully',
      data: {
        ...stats,
        recentContacts,
        unreadContacts
      }
    });

  } catch (error) {
    console.error('Error getting contact stats:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve contact statistics',
      error: error.message
    });
  }
};

// Mark response email as sent (Admin only)
exports.markResponseSent = async (req, res) => {
  try {
    const { id } = req.params;

    const contact = await Contact.findById(id);
    if (!contact) {
      return res.status(404).json({
        success: false,
        message: 'Contact not found'
      });
    }

    await contact.markResponseSent();

    return res.status(200).json({
      success: true,
      message: 'Response email marked as sent',
      data: contact
    });

  } catch (error) {
    console.error('Error marking response as sent:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to mark response as sent',
      error: error.message
    });
  }
};

// Delete contact (Admin only)
exports.deleteContact = async (req, res) => {
  try {
    const { id } = req.params;

    const contact = await Contact.findById(id);
    if (!contact) {
      return res.status(404).json({
        success: false,
        message: 'Contact not found'
      });
    }

    await Contact.findByIdAndDelete(id);

    return res.status(200).json({
      success: true,
      message: 'Contact deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting contact:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete contact',
      error: error.message
    });
  }
};