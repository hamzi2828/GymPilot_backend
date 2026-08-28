const County = require('../models/country');

// Get all counties with states
exports.getAllCounties = async (req, res) => {
    try {
        const { active } = req.query;
        const query = active === 'true' ? { isActive: true } : {};

        const counties = await County.find(query).sort({ name: 1 });
        res.status(200).json({
            success: true,
            data: counties
        });
    } catch (error) {
        console.error('Error fetching counties:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch counties',
            error: error.message
        });
    }
};

// Get single county by ID
exports.getCountyById = async (req, res) => {
    try {
        const county = await County.findById(req.params.id);
        if (!county) {
            return res.status(404).json({
                success: false,
                message: 'County not found'
            });
        }
        res.status(200).json({
            success: true,
            data: county
        });
    } catch (error) {
        console.error('Error fetching county:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch county',
            error: error.message
        });
    }
};

// Create new county
exports.createCounty = async (req, res) => {
    try {
        const { name, code, cities, isActive } = req.body;

        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'County name is required'
            });
        }

        // Check if county already exists
        const existingCounty = await County.findOne({ name: { $regex: new RegExp(`^${name}$`, 'i') } });
        if (existingCounty) {
            return res.status(400).json({
                success: false,
                message: 'County with this name already exists'
            });
        }

        const county = new County({
            name,
            code: code || '',
            cities: cities || [],
            isActive: isActive !== undefined ? isActive : true
        });

        await county.save();

        res.status(201).json({
            success: true,
            message: 'County created successfully',
            data: county
        });
    } catch (error) {
        console.error('Error creating county:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create county',
            error: error.message
        });
    }
};

// Update county
exports.updateCounty = async (req, res) => {
    try {
        const { name, code, isActive } = req.body;

        const county = await County.findById(req.params.id);
        if (!county) {
            return res.status(404).json({
                success: false,
                message: 'County not found'
            });
        }

        // Check if new name conflicts with another county
        if (name && name !== county.name) {
            const existingCounty = await County.findOne({
                name: { $regex: new RegExp(`^${name}$`, 'i') },
                _id: { $ne: req.params.id }
            });
            if (existingCounty) {
                return res.status(400).json({
                    success: false,
                    message: 'County with this name already exists'
                });
            }
        }

        if (name) county.name = name;
        if (code !== undefined) county.code = code;
        if (isActive !== undefined) county.isActive = isActive;

        await county.save();

        res.status(200).json({
            success: true,
            message: 'County updated successfully',
            data: county
        });
    } catch (error) {
        console.error('Error updating county:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update county',
            error: error.message
        });
    }
};

// Delete county
exports.deleteCounty = async (req, res) => {
    try {
        const county = await County.findByIdAndDelete(req.params.id);
        if (!county) {
            return res.status(404).json({
                success: false,
                message: 'County not found'
            });
        }

        res.status(200).json({
            success: true,
            message: 'County deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting county:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete county',
            error: error.message
        });
    }
};

// Add state to county
exports.addState = async (req, res) => {
    try {
        const { name, isActive } = req.body;

        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'State name is required'
            });
        }

        const county = await County.findById(req.params.id);
        if (!county) {
            return res.status(404).json({
                success: false,
                message: 'County not found'
            });
        }

        // Check if state already exists in this county
        const stateExists = county.cities.some(
            state => state.name.toLowerCase() === name.toLowerCase()
        );
        if (stateExists) {
            return res.status(400).json({
                success: false,
                message: 'State already exists in this county'
            });
        }

        county.cities.push({
            name,
            isActive: isActive !== undefined ? isActive : true
        });

        await county.save();

        res.status(201).json({
            success: true,
            message: 'State added successfully',
            data: county
        });
    } catch (error) {
        console.error('Error adding state:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add state',
            error: error.message
        });
    }
};

// Update state
exports.updateState = async (req, res) => {
    try {
        const { countyId, stateId } = req.params;
        const { name, isActive } = req.body;

        const county = await County.findById(countyId);
        if (!county) {
            return res.status(404).json({
                success: false,
                message: 'County not found'
            });
        }

        const state = county.cities.id(stateId);
        if (!state) {
            return res.status(404).json({
                success: false,
                message: 'State not found'
            });
        }

        // Check if new name conflicts with another state in the same county
        if (name && name !== state.name) {
            const stateExists = county.cities.some(
                s => s._id.toString() !== stateId && s.name.toLowerCase() === name.toLowerCase()
            );
            if (stateExists) {
                return res.status(400).json({
                    success: false,
                    message: 'State with this name already exists in this county'
                });
            }
        }

        if (name) state.name = name;
        if (isActive !== undefined) state.isActive = isActive;

        await county.save();

        res.status(200).json({
            success: true,
            message: 'State updated successfully',
            data: county
        });
    } catch (error) {
        console.error('Error updating state:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update state',
            error: error.message
        });
    }
};

// Delete state
exports.deleteState = async (req, res) => {
    try {
        const { countyId, stateId } = req.params;

        const county = await County.findById(countyId);
        if (!county) {
            return res.status(404).json({
                success: false,
                message: 'County not found'
            });
        }

        const state = county.cities.id(stateId);
        if (!state) {
            return res.status(404).json({
                success: false,
                message: 'State not found'
            });
        }

        county.cities.pull(stateId);
        await county.save();

        res.status(200).json({
            success: true,
            message: 'State deleted successfully',
            data: county
        });
    } catch (error) {
        console.error('Error deleting state:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete state',
            error: error.message
        });
    }
};

// Get states for a county (public)
exports.getStatesByCounty = async (req, res) => {
    try {
        const county = await County.findById(req.params.id);
        if (!county) {
            return res.status(404).json({
                success: false,
                message: 'County not found'
            });
        }

        const activeStates = county.cities.filter(state => state.isActive);
        res.status(200).json({
            success: true,
            data: activeStates
        });
    } catch (error) {
        console.error('Error fetching states:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch states',
            error: error.message
        });
    }
};

// Add city to a state (province) inside a country
exports.addCity = async (req, res) => {
    try {
        const { countyId, stateId } = req.params;
        const { name, isActive } = req.body;

        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'City name is required'
            });
        }

        const county = await County.findById(countyId);
        if (!county) {
            return res.status(404).json({ success: false, message: 'Country not found' });
        }

        const state = county.cities.id(stateId);
        if (!state) {
            return res.status(404).json({ success: false, message: 'Province not found' });
        }

        const exists = (state.cities || []).some(
            c => c.name.toLowerCase() === name.toLowerCase()
        );
        if (exists) {
            return res.status(400).json({
                success: false,
                message: 'City already exists in this province'
            });
        }

        state.cities.push({
            name,
            isActive: isActive !== undefined ? isActive : true
        });

        await county.save();

        res.status(201).json({
            success: true,
            message: 'City added successfully',
            data: county
        });
    } catch (error) {
        console.error('Error adding city:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add city',
            error: error.message
        });
    }
};

// Update a city
exports.updateCity = async (req, res) => {
    try {
        const { countyId, stateId, cityId } = req.params;
        const { name, isActive } = req.body;

        const county = await County.findById(countyId);
        if (!county) {
            return res.status(404).json({ success: false, message: 'Country not found' });
        }

        const state = county.cities.id(stateId);
        if (!state) {
            return res.status(404).json({ success: false, message: 'Province not found' });
        }

        const city = state.cities.id(cityId);
        if (!city) {
            return res.status(404).json({ success: false, message: 'City not found' });
        }

        if (name && name !== city.name) {
            const conflict = state.cities.some(
                c => c._id.toString() !== cityId && c.name.toLowerCase() === name.toLowerCase()
            );
            if (conflict) {
                return res.status(400).json({
                    success: false,
                    message: 'City with this name already exists in this province'
                });
            }
        }

        if (name) city.name = name;
        if (isActive !== undefined) city.isActive = isActive;

        await county.save();

        res.status(200).json({
            success: true,
            message: 'City updated successfully',
            data: county
        });
    } catch (error) {
        console.error('Error updating city:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update city',
            error: error.message
        });
    }
};

// Delete a city
exports.deleteCity = async (req, res) => {
    try {
        const { countyId, stateId, cityId } = req.params;

        const county = await County.findById(countyId);
        if (!county) {
            return res.status(404).json({ success: false, message: 'Country not found' });
        }

        const state = county.cities.id(stateId);
        if (!state) {
            return res.status(404).json({ success: false, message: 'Province not found' });
        }

        const city = state.cities.id(cityId);
        if (!city) {
            return res.status(404).json({ success: false, message: 'City not found' });
        }

        state.cities.pull(cityId);
        await county.save();

        res.status(200).json({
            success: true,
            message: 'City deleted successfully',
            data: county
        });
    } catch (error) {
        console.error('Error deleting city:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete city',
            error: error.message
        });
    }
};

// Get cities for a province (public)
exports.getCitiesByState = async (req, res) => {
    try {
        const { countyId, stateId } = req.params;
        const county = await County.findById(countyId);
        if (!county) {
            return res.status(404).json({ success: false, message: 'Country not found' });
        }
        const state = county.cities.id(stateId);
        if (!state) {
            return res.status(404).json({ success: false, message: 'Province not found' });
        }
        const activeCities = (state.cities || []).filter(c => c.isActive);
        res.status(200).json({ success: true, data: activeCities });
    } catch (error) {
        console.error('Error fetching cities:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch cities',
            error: error.message
        });
    }
};
