import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const permissionSchema = new mongoose.Schema({
    view: { type: Boolean, default: false },
    add: { type: Boolean, default: false },
    edit: { type: Boolean, default: false },
    delete: { type: Boolean, default: false }
}, { _id: false });

const userSchema = new mongoose.Schema({
    active: {
        type: Boolean,
        default: true
    },
    name: {
        type: String,
        trim: true
    },
    email: {
        type: String,
        trim: true,
        unique: true
    },
    gender: String,
    dob: String,
    orderCount: {
        type: Number,
        default: 0
    },
    callingCode: {
        type: Number,
        default: 91
    },
    phoneNo: {
        type: String,
        trim: true,
        unique: true
    },
    business: {
        active: {
            type: Boolean,
            default: false
        },
        verified: {
            type: Boolean,
            default: false
        },
        businessName: {
            type: String,
            trim: true
        },
        businessEmail: {
            type: String,
            trim: true
        },
        businessPhone: {
            type: String,
            trim: true
        },
        gstNumber: {
            type: String,
            trim: true
        },
        isApproved: {
            type: Boolean,
            default: false
        },
        gstVerified: {
            type: Boolean,
            default: false
        },
        gstData: {
            type: mongoose.Schema.Types.Mixed
        },
        approvedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        approvedAt: {
            type: Date
        },
        regsiteredAddress: {
            street: {
                type: String,
                // required: true,
            },
            street2: {
                type: String,
            },
            city: {
                type: String,
                // required: true,
            },
            state: {
                type: String,
                // required: true,
            },
            country: {
                type: String,
                // required: true,
                default: "India"
            },
            pinCode: {
                type: String,
                // required: true,
            },
            latitude: {
                type: Number,
            },
            longitude: {
                type: Number,
            }
        }
    },
    address: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Address'
    }],
    password: {
        type: String,
        trim: true
    },
    role: {
        type: String,
        required: true,
        enum: ['admin', 'user', 'employee'],
        default: 'user'
    },
    refreshToken: {
        type: String
    },
    departments: [{
        type: String,
    }],
    otp: {
        type: String,
    },
    otpExpiry: {
        type: Date,
    },
    isPasswordChanged: {
        type: Boolean,
        default: false
    },
    forgotPasswordToken: {
        type: String,
    },
    forgotPasswordExpiry: {
        type: Date,
    },
    profilePicture: {
        type: String,
    },
    documents: [{
        type: String,
    }],
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    permissions: {
        type: Map,
        of: permissionSchema,
        default: () => new Map()
    },
    queries: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Query'
    }],
    orders: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Order'
    }],
    wishlist: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product'
    }],
    cart: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Cart'
    }
}, { timestamps: true });

userSchema.pre("save", async function () {
    if (!this.isModified("password")) return;

    this.password = await bcrypt.hash(this.password, 10);
})

userSchema.methods.isPasswordCorrect = async function (password) {
    return await bcrypt.compare(password, this.password)
}

userSchema.methods.generateAccessToken = function () {
    return jwt.sign(
        {
            _id: this._id,
            email: this.email,
            name: this.name,
            phoneNo: this.phoneNo,
            permissions: this.permissions,
        },
        process.env.ACCESS_TOKEN_SECRET,
        {
            expiresIn: process.env.ACCESS_TOKEN_EXPIRY
        }
    )
}
userSchema.methods.generateRefreshToken = function () {
    return jwt.sign(
        {
            _id: this._id,
            permissions: this.permissions,
        },
        process.env.REFRESH_TOKEN_SECRET,
        {
            expiresIn: process.env.REFRESH_TOKEN_EXPIRY
        }
    )
}

export const User = mongoose.model('User', userSchema);