import { Router } from "express";
import {
    createCustomer,
    createEmployee,
    customerLoginByEmail,
    customerSignupByEmail,
    deleteUser,
    editEmployee,
    getCustomerById,
    getCustomerByMobile,
    getUserById,
    getUserPermissions,
    getUsersByRole,
    loginUser,
    logoutUser,
    placeCancelRequest,
    placeReturnRequest,
    placeWarrantyRequest,
    refreshAccessToken,
    rejectCancelRequest,
    rejectReturnRequest,
    rejectWarrantyRequest,
    sendOtp,
    updateCustomer,
    verifyOtp,
    sendEmailOtp,
    verifyEmailOtp,
    resetPassword,
    forgotPasswordTokenRequest,
    resetPasswordWithToken,
    getUserCart,
    getMyProfile
} from "../controllers/user.controller.js";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
    addProductInWishList,
    removeProductFromWishList
} from "../controllers/wishlist.controller.js";
import {
    createAddress,
    deleteAddress, editAddress,
    getAllAddressByUser
} from "../controllers/address.controller.js";
import { getPaginatedUsers } from "../controllers/pagination.controller.js";

const router = Router()

router.route("/cart").get(verifyJWT, getUserCart);
router.route("/permissions").get(verifyJWT, getUserPermissions);
router.route("/profile/update").post(verifyJWT, updateCustomer);
router.route("/profile").get(verifyJWT, getMyProfile);
router.route("/createCustomer").post(verifyJWT, createCustomer);
router.route("/customer/id/:_id").get(verifyJWT, getCustomerById);
router.route("/customer/:phoneNo").get(verifyJWT, getCustomerByMobile);
router.route("/createUser").post(verifyJWT, createEmployee);
router.route("/sendOtp").post(sendOtp);
router.route("/login").post(verifyOtp, loginUser);
router.route("/send-Email-otp").post(verifyJWT, sendEmailOtp);
router.route("/verify-Email-otp").post(verifyJWT, verifyEmailOtp);
router.route("/reset-password").post(verifyJWT, resetPassword);
router.route("/forgot-password-link").post(forgotPasswordTokenRequest);
router.route("/reset-password/:token").post(resetPasswordWithToken);
router.route("/customer/signup/email").post(customerSignupByEmail);
router.route("/customer/login/email").post(customerLoginByEmail);
router.route("/refresh-token").post(refreshAccessToken)
router.route("/logout").post(verifyJWT, logoutUser);
router.route("/employees/:_id").put(verifyJWT, editEmployee);
router.route("/employees/:_id").delete(verifyJWT, deleteUser);
router.route("/delete").delete(verifyJWT, deleteUser);
router.route("/role/:role").get(verifyJWT, getUsersByRole);
router.route("/:_id").get(verifyJWT, getUserById);
//Paginated Users
router.route("/all/paginated").get(verifyJWT, getPaginatedUsers);

//Whishlist Routes
router.route("/wishlist/add").post(verifyJWT, addProductInWishList);
router.route("/wishlist/remove").post(verifyJWT, removeProductFromWishList);

//Address Routes
router.route("/address/add").post(verifyJWT, createAddress);
router.route("/address/:_id").put(verifyJWT, editAddress);
router.route("/address/:_id").delete(verifyJWT, deleteAddress);
router.route("/address/view").get(verifyJWT, getAllAddressByUser);

//Order Routes
router.route("/request/cancel").post(verifyJWT, placeCancelRequest);
router.route("/request/cancel/reject").post(verifyJWT, rejectCancelRequest);
router.route("/request/warranty").post(verifyJWT, placeWarrantyRequest);
router.route("/request/warranty/reject").post(verifyJWT, rejectWarrantyRequest);
router.route("/request/return").post(verifyJWT, placeReturnRequest);
router.route("/request/return/reject").post(verifyJWT, rejectReturnRequest);

export default router