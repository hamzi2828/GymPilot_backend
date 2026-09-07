// src/gymfolio/models/classExceptionModel.js
//
// A one-off change to the weekly timetable: this session is cancelled, that
// one has a stand-in instructor or a different room, the whole gym is shut
// on a public holiday. Sessions are expanded from each class's weekly
// template (services/classSessions.js), so the exceptions are the only
// thing that has to be stored to describe a particular week.

const mongoose = require('mongoose');
const { tenantModel } = require('../../platform/modelRegistry');

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

const classExceptionSchema = new mongoose.Schema(
  {
    // Null means every class -- a holiday, a closure.
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'GymClass', default: null, index: true },
    className: { type: String, default: '' },
    date: {
      type: String,
      required: true,
      index: true,
      validate: { validator: (v) => DATE_KEY.test(v), message: 'date must be YYYY-MM-DD' }
    },
    // Empty means every session of the class that day.
    startTime: { type: String, default: '' },
    // cancelled: the session does not run (bookings are cancelled when the
    // exception is made). substitute: it runs with a different instructor
    // and/or room.
    kind: { type: String, enum: ['cancelled', 'substitute'], required: true },
    instructor: { type: mongoose.Schema.Types.ObjectId, ref: 'Trainer', default: null },
    instructorName: { type: String, default: '', trim: true },
    room: { type: String, default: '', trim: true },
    note: { type: String, default: '', trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  {
    timestamps: true,
    collection: 'gym_class_exceptions'
  }
);

classExceptionSchema.index({ date: 1, classId: 1, startTime: 1 });

/** Does this exception apply to the given session? */
classExceptionSchema.statics.applies = function (exception, classId, date, startTime) {
  if (exception.date !== date) return false;
  if (exception.classId && String(exception.classId) !== String(classId)) return false;
  if (exception.startTime && exception.startTime !== startTime) return false;
  return true;
};

module.exports = tenantModel('ClassException', classExceptionSchema);
